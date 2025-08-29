// index.js — Multi-salas (perfiles desde CLAIM_CONFIG o CLAIM_CONFIG_FILE en ENV)
// Paneles sin embeds ni mensajes en el canal, botón Cancelar, contador (CLAIM_UPDATE_MS).
// Sala de espera por slot (QUEUE_CAPACITY) + confirmación integrada al panel (CONFIRM_WINDOW_SEC).

import {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionsBitField
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------- ajustes por ENV (Koyeb) ---------- */
const UPDATE_STEP_MS     = Math.max(1000, parseInt(process.env.CLAIM_UPDATE_MS || '30000', 10));
const QUEUE_CAPACITY     = Math.max(0,   parseInt(process.env.QUEUE_CAPACITY || '2', 10));
const CONFIRM_WINDOW_SEC = Math.max(5,   parseInt(process.env.CONFIRM_WINDOW_SEC || '45', 10));

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
const PURGE_LOOP_MAX = 50;
const sleep = (ms) => new Promise(r => setTimeout(r, 350));

/* ---------- cliente ---------- */
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
  // default mínimo
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
    const ids   = Array.isArray(c.ids)   ? c.ids   : (c.id   ? [c.id]   : []);
    const names = Array.isArray(c.names) ? c.names : (c.name ? [c.name] : []);
    const slots = c.slots ? normSlots(c.slots)
      : (c.profile && profiles[c.profile]) ? profiles[c.profile]
      : null;
    if (!slots || !slots.length) continue;
    ids.forEach(id  => out.push({ id: String(id), slots }));
    names.forEach(n => out.push({ name: String(n).toLowerCase(), slots }));
    if (!ids.length && !names.length && c.profile) out.push({ name: 'claimed-pico', slots });
  }
  return { channels: out };
}

/* ---------- estado ---------- */
const anchors       = new Map();  // `${channelId}:${idx}` -> panelMessageId
const planByChannel = new Map();  // channelId -> [{title, minutes}, ...]
const sessions      = new Map();  // panelMessageId -> { ownerId, ... }
const waitlists     = new Map();  // panelMessageId -> [{ userId, minutes, enqueuedAt }]
const pendings      = new Map();  // panelMessageId -> { userId, minutes, deadline, timeout, nonce, userTag }

const keyFor = (chId, idx) => `${chId}:${idx}`;
const GAP_BEFORE = `\n\u200B\n\u200B`;

/* ---------- UI ---------- */
function mmss(ms){ if(ms<0) ms=0; const s=Math.floor(ms/1000), m=Math.floor(s/60), ss=s%60; return `${m<10?'0':''}${m}:${ss<10?'0':''}${ss}`; }
const openText    = (title, idx) => `${idx===0 ? '' : GAP_BEFORE}**${title}**`;
const busyText    = (title, ownerTag, minutes, remMs, idx) => `${idx===0 ? '' : GAP_BEFORE}**${title}** · 🔒 **${ownerTag}** · ⏳ **${mmss(remMs)}** (${minutes}m)`;
const pendingText = (title, userTag, sec, idx) => `${idx===0 ? '' : GAP_BEFORE}**${title}** · 🟡 pendiente de **${userTag}** · confirma en ${sec}s`;

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
function rowPending(idx, panelId, nonce) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`s${idx}_ok_${panelId}_${nonce}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`s${idx}_no_${panelId}_${nonce}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger)
  );
}
async function renderOpen(msg, idx, title, minutes) {
  await msg.edit({ content: openText(title, idx), components: [rowFor(idx, minutes, true, false)] });
}
async function renderBusy(msg, sess) {
  const rem = sess.endAt - Date.now();
  const text = busyText(sess.title, sess.ownerTag, sess.minutesSel, rem, sess.slotIndex);
  if (text !== sess.lastText) {
    // Mantener HABILITADOS los botones de minutos para poder entrar a la cola.
    await msg.edit({
      content: text,
      components: [rowFor(sess.slotIndex, sess.minutes, true, true)]
    });
    sess.lastText = text;
  }
}
async function renderPending(msg, idx, title, userTag, sec, panelId, nonce, minutes) {
  // Fila 1: Confirmar/Rechazar del pendiente; Fila 2: minutos activos para que otros entren a la cola.
  await msg.edit({
    content: pendingText(title, userTag, sec, idx),
    components: [rowPending(idx, panelId, nonce), rowFor(idx, minutes, true, false)]
  });
}

/* ---------- helpers de cola ---------- */
function getQueue(panelId){ if (!waitlists.has(panelId)) waitlists.set(panelId, []); return waitlists.get(panelId); }
function inQueue(queue, userId){ return queue.findIndex(q => q.userId === userId); }
function clearPending(panelId) { const p = pendings.get(panelId); if (p?.timeout) clearTimeout(p.timeout); pendings.delete(panelId); }

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

  // limpiar estados del canal
  for (const [panelId, sess] of sessions) if (sess.chId === ch.id) sessions.delete(panelId);
  for (const [panelId] of waitlists) {
    const ok = await ch.messages.fetch(panelId).then(()=>true).catch(()=>false);
    if (!ok) waitlists.delete(panelId);
  }
  for (const [panelId, p] of pendings) {
    const ok = await ch.messages.fetch(panelId).then(()=>true).catch(()=>false);
    if (!ok) { if (p.timeout) clearTimeout(p.timeout); pendings.delete(panelId); }
  }
  for (let i=0;i<slots.length+10;i++) anchors.delete(keyFor(ch.id, i));

  // crear anclas nuevas
  for (let i=0;i<slots.length;i++){
    const msg = await ch.send({ content: '‎' }); // ancla
    anchors.set(keyFor(ch.id,i), msg.id);
    await renderOpen(msg, i, slots[i].title, slots[i].minutes);
  }
}

/* ---------- promoción / confirmación (integrada al panel, sin mensajes) ---------- */
async function promoteNext(panelMsg, slot, idx){
  const panelId = panelMsg.id;
  const queue = getQueue(panelId);

  if (pendings.has(panelId) || sessions.has(panelId)) return;

  if (queue.length === 0) {
    await renderOpen(panelMsg, idx, slot.title, slot.minutes).catch(()=>{});
    return;
  }

  const next  = queue.shift();
  const nonce = Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  const sec   = CONFIRM_WINDOW_SEC;

  // Mostrar tag (sin ping)
  let userTag = `ID:${next.userId}`;
  try { const u = await client.users.fetch(next.userId); if (u?.tag) userTag = u.tag; } catch {}

  await renderPending(panelMsg, idx, slot.title, userTag, sec, panelId, nonce, slot.minutes);

  const timeout = setTimeout(async ()=>{
    const p = pendings.get(panelId);
    if (!p || p.nonce !== nonce) return;
    clearPending(panelId);
    await promoteNext(panelMsg, slot, idx); // siguiente o queda abierto
  }, sec * 1000);

  pendings.set(panelId, {
    userId: next.userId,
    minutes: next.minutes,
    deadline: Date.now() + sec*1000,
    timeout, nonce, userTag
  });
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
  // watchdog (agrega paneles nuevos si aparecen en config)
  setInterval(async ()=>{
    const cfg2 = await loadConfig();
    for (const [,g] of c.guilds.cache) {
      const channels = await resolveChannels(g, cfg2);
      for (const { ch, slots } of channels) {
        if (!planByChannel.has(ch.id)) await createPanelsForChannel(ch, slots);
      }
    }
  }, 120000);
});

/* ---------- si borran un panel, recrearlo ---------- */
client.on(Events.MessageDelete, async (msg)=>{
  try{
    const plan = planByChannel.get(msg?.channel?.id);
    if (!plan) return;
    for (let i=0;i<plan.length;i++){
      const k = keyFor(msg.channel.id, i);
      if (anchors.get(k) === msg.id){
        const m = await msg.channel.send({ content: '‎' });
        anchors.set(k, m.id);
        sessions.delete(m.id);
        waitlists.delete(m.id);
        clearPending(m.id);
        await renderOpen(m, i, plan[i].title, plan[i].minutes);
        break;
      }
    }
  }catch{}
});

/* ---------- interacciones ---------- */
client.on(Events.InteractionCreate, async i=>{
  if (!i.isButton()) return;

  // 1) Confirmar / Rechazar (sobre el propio panel)
  {
    const m = /^s(\d+)_(ok|no)_(\d+)_(.+)$/.exec(i.customId);
    if (m) {
      const idx = parseInt(m[1], 10);
      const kind = m[2];
      const panelId = m[3];
      const nonce = m[4];

      // el click debe ser en el mismo panel
      if (i.message.id !== panelId) { try { await i.deferUpdate(); } catch {} return; }

      const pending = pendings.get(panelId);
      if (!pending || pending.nonce !== nonce) {
        try { await i.reply({ ephemeral: true, content: '⚠️ Este turno ya no está disponible.' }); } catch {}
        return;
      }
      if (i.user.id !== pending.userId) {
        try { await i.reply({ ephemeral: true, content: '⛔ Este aviso no es para vos.' }); } catch {}
        return;
      }

      const plan = planByChannel.get(i.channel.id);
      if (!plan) { try { await i.deferUpdate(); } catch {} return; }
      const slot = plan[idx];

      if (kind === 'ok') {
        clearPending(panelId);
        const minutesSel = pending.minutes;
        const sess = {
          channel: i.channel, chId: i.channel.id, slotIndex: idx,
          title: slot.title, minutes: slot.minutes, minutesSel,
          ownerId: i.user.id, ownerTag: i.user.tag,
          endAt: Date.now() + minutesSel * 60 * 1000,
          timer: null, lastText: ''
        };
        sessions.set(panelId, sess);

        const render = async () => { await renderBusy(i.message, sess).catch(()=>{}); };
        await render();
        sess.timer = setInterval(()=>render().catch(()=>{}), UPDATE_STEP_MS);

        setTimeout(async ()=>{
          clearInterval(sess.timer);
          sessions.delete(panelId);
          await promoteNext(i.message, slot, idx);
        }, minutesSel * 60 * 1000);

        try { await i.reply({ ephemeral: true, content: `✅ Confirmado. Tenés **${minutesSel}m**.` }); } catch {}
      } else {
        clearPending(panelId);
        await promoteNext(i.message, slot, idx);
        try { await i.reply({ ephemeral: true, content: 'Hecho. Saliste del turno.' }); } catch {}
      }
      return;
    }
  }

  // 2) Panel principal (minutos / cancelar)
  const ch = i.channel;
  if (!ch || ch.type !== ChannelType.GuildText) return;

  const plan = planByChannel.get(ch.id);
  if (!plan) { try { await i.deferUpdate(); } catch{} return; }

  const mm = /^(?:s(\d+)_m(\d+)|cancel_s(\d+))$/.exec(i.customId);
  if (!mm) return;

  const idx = parseInt(mm[1] || mm[3], 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= plan.length) { try { await i.deferUpdate(); } catch{} return; }

  const k = keyFor(ch.id, idx);
  const panelId = anchors.get(k);
  if (!panelId || panelId !== i.message.id) { try { await i.deferUpdate(); } catch{} return; }

  const slot = plan[idx];
  const panelMsg = i.message;

  // cancelar
  if (mm[3]) {
    const sess = sessions.get(panelId);
    const queue = getQueue(panelId);
    const pos = inQueue(queue, i.user.id);

    // cancelar activo (sólo dueño)
    if (sess && i.user.id === sess.ownerId) {
      clearInterval(sess.timer);
      sessions.delete(panelId);
      await promoteNext(panelMsg, slot, idx);
      try { await i.deferUpdate(); } catch {}
      return;
    }
    // cancelar pendiente
    const pending = pendings.get(panelId);
    if (pending && pending.userId === i.user.id) {
      clearPending(panelId);
      await promoteNext(panelMsg, slot, idx);
      try { await i.reply({ ephemeral: true, content: '✅ Cancelaste tu turno pendiente.' }); } catch {}
      return;
    }
    // cancelar posición en cola
    if (pos !== -1) {
      queue.splice(pos, 1);
      try { await i.reply({ ephemeral: true, content: '✅ Saliste de la sala de espera.' }); } catch {}
      return;
    }
    try { await i.reply({ ephemeral: true, content: '⚠️ No tenés nada para cancelar en este slot.' }); } catch {}
    return;
  }

  // iniciar / unirse a cola
  const minutesSel = parseInt(mm[2], 10);
  const minutesList = slot.minutes;
  if (!minutesList.includes(minutesSel)) { try { await i.deferUpdate(); } catch{} return; }

  const queue = getQueue(panelId);
  const alreadyActive  = sessions.get(panelId)?.ownerId === i.user.id;
  const alreadyPending = pendings.get(panelId)?.userId === i.user.id;
  const alreadyInQueue = inQueue(queue, i.user.id) !== -1;

  if (alreadyActive || alreadyPending || alreadyInQueue) {
    try { await i.reply({ ephemeral: true, content: '⚠️ Ya estás participando de este slot.' }); } catch {}
    return;
  }

  // si está libre y sin pendiente, activar directo
  if (!sessions.has(panelId) && !pendings.has(panelId)) {
    const sess = {
      channel: ch, chId: ch.id, slotIndex: idx,
      title: slot.title, minutes: minutesList, minutesSel,
      ownerId: i.user.id, ownerTag: i.user.tag,
      endAt: Date.now() + minutesSel*60*1000,
      timer: null, lastText: ''
    };
    sessions.set(panelId, sess);

    const render = async () => { await renderBusy(panelMsg, sess).catch(()=>{}); };
    await render();
    sess.timer = setInterval(()=>render().catch(()=>{}), UPDATE_STEP_MS);

    setTimeout(async ()=>{
      clearInterval(sess.timer);
      sessions.delete(panelId);
      await promoteNext(panelMsg, slot, idx);
    }, minutesSel*60*1000);

    try { await i.deferUpdate(); } catch {}
    return;
  }

  // si está ocupado o hay pendiente -> cola
  if (queue.length >= QUEUE_CAPACITY) {
    try { await i.reply({ ephemeral: true, content: `⛔ La sala de espera está llena (capacidad ${QUEUE_CAPACITY}).` }); } catch {}
    return;
  }
  queue.push({ userId: i.user.id, minutes: minutesSel, enqueuedAt: Date.now() });
  try { await i.reply({ ephemeral: true, content: `🕒 Entraste en la sala de espera. Posición: **${queue.length}**.` }); } catch {}
});

/* ---------- login (ENV en Koyeb) ---------- */
const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ Falta TOKEN (o DISCORD_TOKEN) en variables de entorno de Koyeb.');
  process.exit(1);
}
client.login(token);
