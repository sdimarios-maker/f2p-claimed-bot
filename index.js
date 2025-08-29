// index.js — Multi-salas con perfiles (claim.config.json)
// Texto sin embeds, limpia canal al iniciar, paneles fijos (título + botones),
// botón Cancelar, contador con throttle (CLAIM_UPDATE_MS), 2 espacios entre bloques.

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionsBitField
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------- ajustes ---------- */
const UPDATE_STEP_MS = Math.max(1000, parseInt(process.env.CLAIM_UPDATE_MS || '30000', 10));
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
const PURGE_LOOP_MAX = 50;
const sleep = (ms) => new Promise(r => setTimeout(r, 350));

/* ---------- cliente (debe ir ANTES de usarlo) ---------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

/* ---------- config ---------- */
async function loadConfig() {
  const file = process.env.CLAIM_CONFIG_FILE;
  if (file) {
    const p = path.resolve(process.cwd(), file);
    const raw = await fs.readFile(p, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  }
  if (process.env.CLAIM_CONFIG) {
    return normalizeConfig(JSON.parse(process.env.CLAIM_CONFIG));
  }
  // default por si no hay archivo
  return normalizeConfig({
    profiles: {
      pico: {
        slots: [
          { title: 'PICO 4', minutes: [30,60,90] },
          { title: 'PICO 5', minutes: [30,60,90] },
          { title: 'PICO 6', minutes: [30,60,90] },
          { title: 'PICO 7', minutes: [30,60,90] }
        ]
      }
    },
    channels: [{ name: 'claimed-pico', profile: 'pico' }]
  });
}
function normSlots(slots) {
  return (slots || [])
    .map(s => ({
      title: String(s.title || '').trim() || 'PICO',
      minutes: (s.minutes || [30,60,90]).slice(0,4).map(n => parseInt(n,10)).filter(n => n>0)
    }))
    .filter(s => s.minutes.length >= 1);
}
function normalizeConfig(cfg) {
  const profiles = {};
  for (const [k, v] of Object.entries(cfg.profiles || {})) {
    const ns = normSlots(v.slots);
    if (ns.length) profiles[k] = ns;
  }
  const out = [];
  for (const c of cfg.channels || []) {
    const ids = Array.isArray(c.ids) ? c.ids : (c.id ? [c.id] : []);
    const names = Array.isArray(c.names) ? c.names : (c.name ? [c.name] : []);
    const slots = c.slots ? normSlots(c.slots)
                : (c.profile && profiles[c.profile]) ? profiles[c.profile]
                : null;
    if (!slots || !slots.length) continue;
    ids.forEach(id => out.push({ id: String(id), slots }));
    names.forEach(nm => out.push({ name: String(nm).toLowerCase(), slots }));
    if (!ids.length && !names.length && c.profile) {
      out.push({ name: 'claimed-pico', slots });
    }
  }
  return { channels: out };
}

/* ---------- estado ---------- */
const anchors = new Map();        // `${channelId}:${idx}` -> messageId
const planByChannel = new Map();  // channelId -> [{title, minutes}, ...]
const sessions = new Map();       // messageId -> sess

const keyFor = (chId, idx) => `${chId}:${idx}`;
const GAP_BEFORE = `\n\u200B\n\u200B`; // 2 espacios visuales

/* ---------- UI ---------- */
function mmss(ms){ if(ms<0) ms=0; const s=Math.floor(ms/1000), m=Math.floor(s/60), ss=s%60; return `${m<10?'0':''}${m}:${ss<10?'0':''}${ss}`; }
const openText = (title, idx) => `${idx===0 ? '' : GAP_BEFORE}**${title}**`;
const busyText = (title, ownerTag, minutes, remMs, idx) =>
  `${idx===0 ? '' : GAP_BEFORE}**${title}** · 🔒 **${ownerTag}** · ⏳ **${mmss(remMs)}** (${minutes}m)`;

function rowFor(idx, minutes, enableDur, enableCancel) {
  const row = new ActionRowBuilder();
  minutes.slice(0,4).forEach((m, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`s${idx}_m${m}`)
        .setLabel(String(m))
        .setStyle(i===0 ? ButtonStyle.Success : i===1 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!enableDur)
    );
  });
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`cancel_s${idx}`)
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!enableCancel)
  );
  return row;
}
async function renderOpen(msg, idx, title, minutes) {
  await msg.edit({ content: openText(title, idx), components: [rowFor(idx, minutes, true, false)] });
}
async function renderBusy(msg, sess) {
  const rem = sess.endAt - Date.now();
  const text = busyText(sess.title, sess.ownerTag, sess.minutesSel, rem, sess.slotIndex);
  if (text !== sess.lastText) {
    await msg.edit({ content: text, components: [rowFor(sess.slotIndex, sess.minutes, false, true)] });
    sess.lastText = text;
  }
}

/* ---------- limpieza ---------- */
async function purgeChannel(ch){
  try{
    const me = ch.guild?.members?.me;
    const perm = ch.permissionsFor(me);
    if (!perm?.has(PermissionsBitField.Flags.ViewChannel) || !perm?.has(PermissionsBitField.Flags.ReadMessageHistory)) return;
    const canManage = perm.has(PermissionsBitField.Flags.ManageMessages);

    if (!canManage){
      const mine = await ch.messages.fetch({ limit: 100 }).catch(()=>null);
      if (mine) for (const m of mine.filter(m=>m.author?.id===client.user.id).values()) await m.delete().catch(()=>{});
      return;
    }
    for (let i=0;i<PURGE_LOOP_MAX;i++){
      const batch = await ch.messages.fetch({ limit: 100 }).catch(()=>null);
      if (!batch || batch.size===0) break;
      await ch.bulkDelete(100, true).catch(()=>{});
      const older = batch.filter(m => (Date.now() - (m.createdTimestamp || 0)) >= TWO_WEEKS);
      for (const m of older.values()) await m.delete().catch(()=>{});
      if (batch.size < 100) break;
      await sleep(350);
    }
  }catch{}
}

/* ---------- resolución de canales ---------- */
async function resolveChannels(guild, cfg){
  const found = [];
  for (const c of cfg.channels) {
    let ch = null;
    if (c.id) ch = await guild.channels.fetch(c.id).catch(()=>null);
    if (!ch && c.name) ch = guild.channels.cache.find(x=>x.type===ChannelType.GuildText && x.name.toLowerCase()===c.name);
    if (ch && ch.type===ChannelType.GuildText) found.push({ ch, slots: c.slots });
  }
  return found;
}

/* ---------- creación por sala ---------- */
async function createPanelsForChannel(ch, slots){
  await purgeChannel(ch);
  planByChannel.set(ch.id, slots);
  for (let i=0;i<slots.length;i++) anchors.delete(keyFor(ch.id,i));
  for (let i=0;i<slots.length;i++){
    const msg = await ch.send({ content: '‎' }); // ancla
    anchors.set(keyFor(ch.id,i), msg.id);
    await renderOpen(msg, i, slots[i].title, slots[i].minutes);
  }
}

/* ---------- ready ---------- */
client.once(Events.ClientReady, async (c)=>{
  console.log('✅ Bot conectado como ' + c.user.tag);
  try { c.user.setPresence({ activities: [{ name: 'multi-salas (perfiles)' }], status: 'online' }); } catch {}
  const cfg = await loadConfig();
  for (const [,g] of c.guilds.cache) {
    const channels = await resolveChannels(g, cfg);
    for (const { ch, slots } of channels) await createPanelsForChannel(ch, slots);
  }
  setInterval(async ()=>{
    for (const [,g] of c.guilds.cache) {
      const cfg2 = await loadConfig();
      const channels = await resolveChannels(g, cfg2);
      for (const { ch, slots } of channels) {
        if (!planByChannel.has(ch.id)) await createPanelsForChannel(ch, slots);
      }
    }
  }, 120000);
});

/* ---------- borrar panel -> recrear ---------- */
client.on(Events.MessageDelete, async (msg)=>{
  try{
    const plan = planByChannel.get(msg?.channel?.id);
    if (!plan) return;
    for (let i=0;i<plan.length;i++){
      const k = keyFor(msg.channel.id, i);
      if (anchors.get(k) === msg.id){
        const m = await msg.channel.send({ content: '‎' });
        anchors.set(k, m.id);
        await renderOpen(m, i, plan[i].title, plan[i].minutes);
        break;
      }
    }
  }catch{}
});

/* ---------- interacciones ---------- */
client.on(Events.InteractionCreate, async i=>{
  if (!i.isButton()) return;
  const ch = i.channel;
  if (!ch || ch.type !== ChannelType.GuildText) return;

  const plan = planByChannel.get(ch.id);
  if (!plan) { await i.deferUpdate().catch(()=>{}); return; }

  const m = /^(?:s(\d+)_m(\d+)|cancel_s(\d+))$/.exec(i.customId);
  if (!m) return;

  const idx = parseInt(m[1] || m[3], 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= plan.length) { await i.deferUpdate().catch(()=>{}); return; }

  const k = keyFor(ch.id, idx);
  if (anchors.get(k) !== i.message.id) { await i.deferUpdate().catch(()=>{}); return; }

  // cancelar
  if (m[3]) {
    const sess = sessions.get(i.message.id);
    if (!sess || i.user.id !== sess.ownerId) { await i.deferUpdate().catch(()=>{}); return; }
    clearInterval(sess.timer);
    sessions.delete(i.message.id);
    await i.deferUpdate().catch(()=>{});
    await renderOpen(i.message, idx, plan[idx].title, plan[idx].minutes).catch(()=>{});
    return;
  }

  // iniciar
  const minutesSel = parseInt(m[2], 10);
  const minutesList = plan[idx].minutes;
  if (!minutesList.includes(minutesSel)) { await i.deferUpdate().catch(()=>{}); return; }
  if (sessions.has(i.message.id)) { await i.deferUpdate().catch(()=>{}); return; }

  await i.deferUpdate().catch(()=>{});
  const endAt = Date.now() + minutesSel*60*1000;
  const sess = {
    channel: ch, chId: ch.id, slotIndex: idx,
    title: plan[idx].title, minutes: minutesList, minutesSel,
    ownerId: i.user.id, ownerTag: i.user.tag,
    endAt, timer: null, lastText: ''
  };
  sessions.set(i.message.id, sess);

  const render = async () => {
    const rem = sess.endAt - Date.now();
    const t = busyText(sess.title, sess.ownerTag, sess.minutesSel, rem, sess.slotIndex);
    if (t !== sess.lastText) {
      await i.message.edit({ content: t, components: [rowFor(sess.slotIndex, sess.minutes, false, true)] });
      sess.lastText = t;
    }
  };
  await render().catch(()=>{});
  sess.timer = setInterval(()=>render().catch(()=>{}), UPDATE_STEP_MS);

  setTimeout(async ()=>{
    clearInterval(sess.timer);
    sessions.delete(i.message.id);
    await renderOpen(i.message, idx, plan[idx].title, plan[idx].minutes).catch(()=>{});
  }, minutesSel*60*1000);
});

/* ---------- login ---------- */
client.login(process.env.TOKEN);
