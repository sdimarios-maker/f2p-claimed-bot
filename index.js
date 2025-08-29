// index.js — Multi-salas con perfiles (claim.config.json o ENV)
// Texto sin embeds, limpia canal al iniciar, paneles fijos (título + botones),
// botón Cancelar, contador con throttle (CLAIM_UPDATE_MS), 2 espacios entre bloques.
// + Sala de espera por slot (QUEUE_CAPACITY) y confirmación (CONFIRM_WINDOW_SEC)

import {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionsBitField
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------- ajustes por ENV (Koyeb) ---------- */
const UPDATE_STEP_MS = Math.max(1000, parseInt(process.env.CLAIM_UPDATE_MS || '30000', 10));
const QUEUE_CAPACITY = Math.max(0, parseInt(process.env.QUEUE_CAPACITY || '2', 10));
const CONFIRM_WINDOW_SEC = Math.max(5, parseInt(process.env.CONFIRM_WINDOW_SEC || '45', 10));

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
const PURGE_LOOP_MAX = 50;
const sleep = (ms) => new Promise(r => setTimeout(r, 350));

/* ---------- cliente ---------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

/* ---------- config ---------- */
async function loadConfig() {
  // Preferencia: CLAIM_CONFIG_FILE (ruta) > CLAIM_CONFIG (JSON string) > default
  const file = process.env.CLAIM_CONFIG_FILE;
  if (file) {
    const p = path.resolve(process.cwd(), file);
    const raw = await fs.readFile(p, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  }
  if (process.env.CLAIM_CONFIG) {
    return normalizeConfig(JSON.parse(process.env.CLAIM_CONFIG));
  }
  // default mínimo (si no pasaste nada por ENV)
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
    if (!ids.length && !names.length && c.profile) out.push({ name: 'claimed-pico', slots });
  }
  return { channels: out };
}

/* ---------- estado ---------- */
const anchors = new Map();        // `${channelId}:${idx}` -> panelMessageId (ancla)
const planByChannel = new Map();  // channelId -> [{title, minutes}, ...]
const sessions = new Map();       // panelMessageId -> sess (activo)
const waitlists = new Map();      // panelMessageId -> [{ userId, minutes, enqueuedAt }]
const pendings = new Map();       // panelMessageId -> { userId, minutes, confirmMsgId, deadline, timeout, nonce }

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

/* ---------- helpers de cola ---------- */
function getQueue(panelId){ if (!waitlists.has(panelId)) waitlists.set(panelId, []); return waitlists.get(panelId); }
function inQueue(queue, userId){ return queue.findIndex(q => q.userId === userId); }
function clearPending(panelId) {
  const p = pendings.get(panelId);
  if (p?.timeout) clearTimeout(p.timeout);
  pendings.delete(panelId);
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
    // reset estado
    sessions.delete(msg.id);
    waitlists.delete(msg.id);
    clearPending(msg.id);
    await renderOpen(msg, i, slots[i].title, slots[i].minutes);
  }
}

/* ---------- promoción / confirmación ---------- */
async function promoteNext(panelMsg, slot, idx){
  const panelId = panelMsg.id;
  const ch = panelMsg.channel;
  const queue = getQueue(panelId);

  if (pendings.has(panelId) || sessions.has(panelId)) return;

  if (queue.length === 0) {
    await renderOpen(panelMsg, idx, slot.title, slot.minutes).catch(()=>{});
    try { await ch.send(`🟢 **${slot.title}** quedó libre.`); } catch {}
    return;
  }

  const next = queue.shift();
  const nonce = Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  const sec = CONFIRM_WINDOW_SEC;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`s${idx}_ok_${panelId}_${nonce}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`s${idx}_no_${panelId}_${nonce}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger)
  );

  let confirmMsg = null;
  try {
    confirmMsg = await ch.send({
      content: `🔔 <@${next.userId}>, es tu turno en **${slot.title}** por **${next.minutes}m**.\nTenés **${sec}s** para confirmar, o perdés el turno.`,
      components: [row]
    });
  } catch {}

  const timeout = setTimeout(async ()=>{
    const p = pendings.get(panelId);
    if (!p || p.nonce !== nonce) return;
    clearPending(panelId);
    try { await confirmMsg?.edit({ components: [] }); } catch {}
    try { await ch.send(`⌛ <@${next.userId}> no confirmó a tiempo en **${slot.title}**. Pasando al siguiente…`); } catch {}
    await promoteNext(panelMsg, slot, idx);
  }, sec * 1000);

  pendings.set(panelId, {
    userId: next.userId, minutes: next.minutes,
    confirmMsgId: confirmMsg?.id || null,
    deadline: Date.now() + sec*1000,
    timeout, nonce
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
  // watchdog simple por si cambiás canales en ENV/archivo mientras corre
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

  // 1) Confirm/Decline (mensaje aparte)
  {
    const m = /^s(\d+)_(ok|no)_(\d+)_(.+)$/.exec(i.customId);
    if (m) {
      const idx = parseInt(m[1], 10);
      const kind = m[2];
      const panelId = m[3];
      const nonce = m[4];

      const pending = pendings.get(panelId);
      if (!pending || pending.nonce !== nonce) {
        try { await i.reply({ ephemeral: true, content: '⚠️ Este turno ya no está disponible.' }); } catch {}
        return;
      }
      if (i.user.id !== pending.userId) {
        try { await i.reply({ ephemeral: true, content: '⛔ Este aviso no es para vos.' }); } catch {}
        return;
      }

      const panelMsg = await i.channel.messages.fetch(panelId).catch(()=>null);
      const ch = i.channel;
      if (!panelMsg) { try { await i.deferUpdate(); } catch{} return; }

      try { await i.message.edit({ components: [] }); } catch {}

      const plan = planByChannel.get(panelMsg.channel.id);
      if (!plan) { try { await i.deferUpdate(); } catch{} return; }
      const slot = plan[idx];

      if (kind === 'ok') {
        clearPending(panelId);
        const minutesSel = pending.minutes;
        const sess = {
          channel: panelMsg.channel, chId: panelMsg.channel.id, slotIndex: idx,
          title: slot.title, minutes: slot.minutes, minutesSel,
          ownerId: i.user.id, ownerTag: i.user.tag,
          endAt: Date.now() + minutesSel * 60 * 1000,
          timer: null, lastText: ''
        };
        sessions.set(panelId, sess);

        const render = async () => { await renderBusy(panelMsg, sess).catch(()=>{}); };
        await render();
        sess.timer = setInterval(()=>render().catch(()=>{}), UPDATE_STEP_MS);

        setTimeout(async ()=>{
          clearInterval(sess.timer);
          sessions.delete(panelId);
          try { await ch.send(`⏱️ Se terminó el tiempo de <@${sess.ownerId}> en **${slot.title}**.`); } catch {}
          await promoteNext(panelMsg, slot, idx);
        }, minutesSel * 60 * 1000);

        try { await i.reply({ ephemeral: true, content: `✅ Confirmado. Tenés **${minutesSel}m**.` }); } catch {}
      } else {
        const who = pending.userId;
        clearPending(panelId);
        try { await ch.send(`❎ <@${who}> rechazó su turno en **${slot.title}**. Pasando al siguiente…`); } catch {}
        await promoteNext(panelMsg, slot, idx);
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

    if (sess && i.user.id === sess.ownerId) {
      clearInterval(sess.timer);
      sessions.delete(panelId);
      try { await i.deferUpdate(); } catch {}
      try { await ch.send(`🛑 <@${sess.ownerId}> canceló su tiempo en **${slot.title}**.`); } catch {}
      await promoteNext(panelMsg, slot, idx);
      return;
    }
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
  const alreadyActive = sessions.get(panelId)?.ownerId === i.user.id;
  const alreadyPending = pendings.get(panelId)?.userId === i.user.id;
  const alreadyInQueue = inQueue(queue, i.user.id) !== -1;

  if (alreadyActive || alreadyPending || alreadyInQueue) {
    try { await i.reply({ ephemeral: true, content: '⚠️ Ya estás participando de este slot.' }); } catch {}
    return;
  }

  if (!sessions.has(panelId) && !pendings.has(panelId)) {
    try { await i.deferUpdate(); } catch {}
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
      try { await ch.send(`⏱️ Se terminó el tiempo de <@${sess.ownerId}> en **${slot.title}**.`); } catch {}
      await promoteNext(panelMsg, slot, idx);
    }, minutesSel*60*1000);

    return;
  }

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
