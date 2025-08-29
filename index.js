// index.js — Multi-salas con DMs, cooldown por cancelación y bloqueo global de multi-claim
// - Botones siempre en el panel del canal (sin mensajes en canal)
// - DMs con link "Ver panel" y "Salir de la cola"
// - Cooldown configurable por cancelación (CANCEL_COOLDOWN_SEC o _MIN)
// - BLOQUEO GLOBAL: un usuario no puede estar activo/pendiente/en cola en más de un slot a la vez
// - Fix: al cancelar o recrear panel, no envía el DM de “tu tiempo terminó” (limpia interval/timeout)

import {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionsBitField
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------- ajustes por ENV (Koyeb) ---------- */
const UPDATE_STEP_MS       = Math.max(1000, parseInt(process.env.CLAIM_UPDATE_MS || '30000', 10));
const QUEUE_CAPACITY       = Math.max(0,   parseInt(process.env.QUEUE_CAPACITY || '2', 10));
const CONFIRM_WINDOW_SEC   = Math.max(5,   parseInt(process.env.CONFIRM_WINDOW_SEC || '45', 10));
// Prioridad: segundos > minutos
const COOLDOWN_MS = (() => {
  const sec = parseInt(process.env.CANCEL_COOLDOWN_SEC || '0', 10);
  if (sec > 0) return sec * 1000;
  const min = Math.max(0, parseInt(process.env.CANCEL_COOLDOWN_MIN || '120', 10));
  return min * 60 * 1000;
})();
const COOLDOWN_LABEL = COOLDOWN_MS >= 60000
  ? `${Math.round(COOLDOWN_MS/60000)}m`
  : `${Math.round(COOLDOWN_MS/1000)}s`;

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
const PURGE_LOOP_MAX = 50;
const sleep = (ms) => new Promise(r => setTimeout(r, 350));

/* ---------- cliente ---------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
console.log(`⚙️ Cooldown: ${COOLDOWN_LABEL} (${COOLDOWN_MS}ms) usando ${process.env.CANCEL_COOLDOWN_SEC ? 'SEC' : 'MIN'}`);

/* ---------- util DMs ---------- */
const jumpLink = (guildId, channelId, messageId) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

const whereStr = (panelMsg, slotTitle) =>
  `**${slotTitle}** en <#${panelMsg.channelId}>`;

async function dmOnly(i, content, components = []) {
  try { await i.user.send({ content, components }); } catch {}
  try { await i.deferUpdate(); } catch {}
}

async function dmUser(userId, payload) {
  try { const u = await client.users.fetch(userId); await u.send(payload); return true; }
  catch { return false; }
}

/* ---------- helpers tiempo ---------- */
function mmss(ms){ if(ms<0) ms=0; const s=Math.floor(ms/1000), m=Math.floor(s/60), ss=s%60; return `${m<10?'0':''}${m}:${ss<10?'0':''}${ss}`; }
function fmtRemain(ms){
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms/1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);
  const h = Math.floor(m/60);
  const mm = m % 60;
  return h ? `${h}h ${mm}m` : `${m}m`;
}

/* ---------- config ---------- */
async function loadConfig() {
  const file = process.env.CLAIM_CONFIG_FILE;
  if (file) {
    const p = path.resolve(process.cwd(), file);
    const raw = await fs.readFile(p, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  }
  if (process.env.CLAIM_CONFIG) return normalizeConfig(JSON.parse(process.env.CLAIM_CONFIG));
  // default mínimo
  return normalizeConfig({
    profiles: {
      pico: { slots: [
        { title: 'PICO 4', minutes: [30,60,90] },
        { title: 'PICO 5', minutes: [30,60,90] },
        { title: 'PICO 6', minutes: [30,60,90] },
        { title: 'PICO 7', minutes: [30,60,90] }
      ] }
    },
    channels: [{ name: 'claimed-pico', profile: 'pico' }]
  });
}
function normSlots(slots) {
  return (slots || []).map(s => ({
    title: String(s.title || '').trim() || 'PICO',
    minutes: (s.minutes || [30,60,90]).slice(0,4).map(n => parseInt(n,10)).filter(n => n>0)
  })).filter(s => s.minutes.length >= 1);
}
function normalizeConfig(cfg) {
  const profiles = {};
  for (const [k, v] of Object.entries(cfg.profiles || {})) {
    const ns = normSlots(v.slots); if (ns.length) profiles[k] = ns;
  }
  const out = [];
  for (const c of cfg.channels || []) {
    const ids   = Array.isArray(c.ids)   ? c.ids   : (c.id   ? [c.id]   : []);
    const names = Array.isArray(c.names) ? c.names : (c.name ? [c.name] : []);
    const slots = c.slots ? normSlots(c.slots)
      : (c.profile && profiles[c.profile]) ? profiles[c.profile] : null;
    if (!slots?.length) continue;
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
const waitlists     = new Map();  // panelMessageId -> [{ userId, minutes, enqueuedAt, tag }]
const pendings      = new Map();  // panelMessageId -> { userId, minutes, deadline, timeout, nonce, userTag }
const cooldowns     = new Map();  // `${channelId}:${idx}:${userId}` -> untilMs

const keyFor = (chId, idx) => `${chId}:${idx}`;
const coolKey = (chId, idx, userId) => `${chId}:${idx}:${userId}`;

function applyCooldown(chId, idx, userId){
  if (COOLDOWN_MS <= 0) return;
  cooldowns.set(coolKey(chId, idx, userId), Date.now() + COOLDOWN_MS);
}
function hasCooldown(chId, idx, userId){
  const until = cooldowns.get(coolKey(chId, idx, userId)) || 0;
  const rem = until - Date.now();
  return [rem > 0, rem];
}

/* ---------- helpers de panel / bloqueo global ---------- */
// inverso de anchors: panelId -> { chId, idx }
function reverseAnchor(panelId){
  for (const [k, v] of anchors) {
    if (v === panelId) {
      const [chId, idxStr] = k.split(':');
      return { chId, idx: parseInt(idxStr, 10) };
    }
  }
  return null;
}
function slotTitleBy(chId, idx){
  const plan = planByChannel.get(chId);
  return plan?.[idx]?.title || 'Slot';
}
async function describePanel(panelId){
  const ref = reverseAnchor(panelId);
  if (!ref) return { text: 'otro slot', url: null };
  const title = slotTitleBy(ref.chId, ref.idx);
  let ch = client.channels.cache.get(ref.chId);
  if (!ch) ch = await client.channels.fetch(ref.chId).catch(()=>null);
  const guildId = ch?.guildId;
  const url = guildId ? jumpLink(guildId, ref.chId, panelId) : null;
  return { text: `**${title}** en <#${ref.chId}>`, url };
}
// Busca si el usuario participa en ALGÚN otro panel (activo/pendiente/cola)
function findGlobalConflict(userId, exceptPanelId = null){
  for (const [pid, sess] of sessions) {
    if (pid !== exceptPanelId && sess.ownerId === userId) return { type: 'activo', panelId: pid };
  }
  for (const [pid, p] of pendings) {
    if (pid !== exceptPanelId && p.userId === userId) return { type: 'pendiente', panelId: pid };
  }
  for (const [pid, q] of waitlists) {
    if (pid === exceptPanelId) continue;
    if (q.some(e => e.userId === userId)) return { type: 'cola', panelId: pid };
  }
  return null;
}

/* ---------- UI ---------- */
const GAP_BEFORE = `\n\u200B\n\u200B`;
const openText    = (title, idx) => `${idx===0 ? '' : GAP_BEFORE}**${title}**`;
const busyText    = (title, ownerTag, minutes, remMs, idx) => `${idx===0 ? '' : GAP_BEFORE}**${title}** · 🔒 **${ownerTag}** · ⏳ **${mmss(remMs)}** (${minutes}m)`;
const pendingText = (title, userTag, sec, idx) => `${idx===0 ? '' : GAP_BEFORE}**${title}** · 🟡 pendiente de **${userTag}** · confirma en ${sec}s`;

// vista cola (muestra hasta 3)
function queueLine(panelId){
  const q = getQueue(panelId);
  if (!q.length) return '';
  const names = q.slice(0,3).map(e => `**${e.tag || ('ID:'+e.userId)}** ${e.minutes}m`).join(' · ');
  const more  = q.length > 3 ? `  +${q.length-3} más` : '';
  return `\n*📝 Cola:* ${names}${more}`;
}

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
function dmQueueRow(panelMsg){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ver panel').setURL(jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)),
    new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel('Salir de la cola').setCustomId(`dm_cancel_${panelMsg.id}`)
  );
}

async function renderOpen(msg, idx, title, minutes) {
  await msg.edit({ content: openText(title, idx) + queueLine(msg.id), components: [rowFor(idx, minutes, true, false)] });
}
async function renderBusy(msg, sess) {
  const rem = sess.endAt - Date.now();
  const content = busyText(sess.title, sess.ownerTag, sess.minutesSel, rem, sess.slotIndex) + queueLine(msg.id);
  if (content !== sess.lastText) {
    await msg.edit({ content, components: [rowFor(sess.slotIndex, sess.minutes, true, true)] });
    sess.lastText = content;
  }
}
async function renderPending(msg, idx, title, userTag, sec, panelId, nonce, minutes) {
  await msg.edit({
    content: pendingText(title, userTag, sec, idx) + queueLine(msg.id),
    components: [rowPending(idx, panelId, nonce), rowFor(idx, minutes, true, true)]
  });
}

/* ---------- helpers de cola ---------- */
function getQueue(panelId){ if (!waitlists.has(panelId)) waitlists.set(panelId, []); return waitlists.get(panelId); }
function inQueue(queue, userId){ return queue.findIndex(q => q.userId === userId); }
function clearPending(panelId) { const p = pendings.get(panelId); if (p?.timeout) clearTimeout(p.timeout); pendings.delete(panelId); }

async function refreshPanel(panelMsg, idx, slot){
  const panelId = panelMsg.id;
  const sess = sessions.get(panelId);
  const pend = pendings.get(panelId);
  if (sess) await renderBusy(panelMsg, sess);
  else if (pend) {
    const secLeft = Math.max(0, Math.ceil((pend.deadline - Date.now())/1000));
    await renderPending(panelMsg, idx, slot.title, pend.userTag, secLeft, panelId, pend.nonce, slot.minutes);
  } else await renderOpen(panelMsg, idx, slot.title, slot.minutes);
}

/* ---------- limpiar sesiones / timers ---------- */
function stopSessionById(panelId){
  const s = sessions.get(panelId);
  if (!s) return;
  try { clearInterval(s.timer); } catch {}
  try { clearTimeout(s.endTO); } catch {}
  sessions.delete(panelId);
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

  // Apagar sesiones y limpiar estados del canal
  for (const [panelId, sess] of sessions) {
    if (sess.chId === ch.id) stopSessionById(panelId);
  }
  for (const [panelId] of waitlists) {
    const ok = await ch.messages.fetch(panelId).then(()=>true).catch(()=>false);
    if (!ok) waitlists.delete(panelId);
  }
  for (const [panelId, p] of pendings) {
    const ok = await ch.messages.fetch(panelId).then(()=>true).catch(()=>false);
    if (!ok) { if (p.timeout) clearTimeout(p.timeout); pendings.delete(panelId); }
  }

  // Reset de anclas
  for (let i=0;i<slots.length+10;i++) anchors.delete(keyFor(ch.id, i));

  // Crear paneles
  for (let i=0;i<slots.length;i++){
    const msg = await ch.send({ content: '‎' });
    anchors.set(keyFor(ch.id,i), msg.id);
    await renderOpen(msg, i, slots[i].title, slots[i].minutes);
  }
}

/* ---------- promoción / confirmación (integrada al panel) ---------- */
async function promoteNext(panelMsg, slot, idx){
  const panelId = panelMsg.id;
  const queue = getQueue(panelId);

  if (pendings.has(panelId) || sessions.has(panelId)) return;

  while (queue.length > 0) {
    const next = queue.shift();

    // Cooldown por cancelación
    const [inCd, rem] = hasCooldown(panelMsg.channel.id, idx, next.userId);
    if (inCd) {
      await dmUser(next.userId, {
        content:
          `⛔ Estás en cooldown en ${whereStr(panelMsg, slot.title)}.\n` +
          `Te quedan **${fmtRemain(rem)}**. Te saltamos en la cola.`
      });
      continue;
    }

    // BLOQUEO GLOBAL: si ya participa en otro slot (activo/pendiente/cola), saltar
    const conflict = findGlobalConflict(next.userId, panelId);
    if (conflict) {
      const d = await describePanel(conflict.panelId);
      await dmUser(next.userId, {
        content:
          `⛔ No podés tomar otra sala mientras estás **${conflict.type}** en ${d.text}` +
          (d.url ? `.\nPanel: ${d.url}` : '.')
      });
      continue;
    }

    const nonce = Math.random().toString(36).slice(2,10) + Date.now().toString(36);
    const sec   = CONFIRM_WINDOW_SEC;
    const userTag = next.tag || `ID:${next.userId}`;

    await renderPending(panelMsg, idx, slot.title, userTag, sec, panelId, nonce, slot.minutes);

    await dmUser(next.userId, {
      content:
        `🔔 Te toca en ${whereStr(panelMsg, slot.title)} por **${next.minutes}m**.\n` +
        `Tenés **${sec}s** para confirmar.\n` +
        `Panel: ${jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)}`,
      components: [dmQueueRow(panelMsg)]
    });

    const timeout = setTimeout(async ()=>{
      const p = pendings.get(panelId);
      if (!p || p.nonce !== nonce) return;
      clearPending(panelId);
      await promoteNext(panelMsg, slot, idx);
    }, sec * 1000);

    pendings.set(panelId, {
      userId: next.userId, minutes: next.minutes,
      deadline: Date.now() + sec*1000, timeout, nonce, userTag
    });
    return;
  }

  await renderOpen(panelMsg, idx, slot.title, slot.minutes).catch(()=>{});
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
        // limpiar el panel BORRADO (msg.id), no el nuevo
        stopSessionById(msg.id);
        waitlists.delete(msg.id);
        clearPending(msg.id);

        // crear ancla nueva
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

  // A) Botón DM: “Salir de la cola”
  {
    const m = /^dm_cancel_(\d+)$/.exec(i.customId);
    if (m) {
      const panelId = m[1];
      let chId = null, idx = null;
      for (const [k, v] of anchors) if (v === panelId) { [chId, idx] = k.split(':'); idx = parseInt(idx,10); break; }
      if (!chId || Number.isNaN(idx)) { try { await i.reply('⚠️ Ese panel ya no existe.'); } catch {} return; }
      const ch = await client.channels.fetch(chId).catch(()=>null);
      if (!ch || ch.type !== ChannelType.GuildText) { try { await i.reply('⚠️ Canal inválido.'); } catch {} return; }
      const panelMsg = await ch.messages.fetch(panelId).catch(()=>null);
      if (!panelMsg) { try { await i.reply('⚠️ El panel fue recreado.'); } catch {} return; }

      const plan = planByChannel.get(ch.id);
      const slot = plan?.[idx];
      if (!slot) { try { await i.reply('⚠️ Slot inválido.'); } catch {} return; }

      const queue = getQueue(panelId);
      const pos = inQueue(queue, i.user.id);
      const pending = pendings.get(panelId);

      if (pending && pending.userId === i.user.id) {
        clearPending(panelId);
        await promoteNext(panelMsg, slot, idx);
        try { await i.reply(`✅ Saliste del turno pendiente de ${whereStr(panelMsg, slot.title)}.`); } catch {}
        return;
      }
      if (pos !== -1) {
        queue.splice(pos,1);
        await refreshPanel(panelMsg, idx, slot);
        try { await i.reply(`✅ Saliste de la sala de espera de ${whereStr(panelMsg, slot.title)}.`); } catch {}
        return;
      }
      try { await i.reply(`ℹ️ No estás en la cola de ${whereStr(panelMsg, slot.title)}.`); } catch {}
      return;
    }
  }

  // B) Confirmar / Rechazar (desde panel o DM)
  {
    const m = /^s(\d+)_(ok|no)_(\d+)_(.+)$/.exec(i.customId);
    if (m) {
      const idx = parseInt(m[1], 10), kind = m[2], panelId = m[3], nonce = m[4];
      let chId = null; for (const [k, v] of anchors) if (v === panelId) { [chId] = k.split(':'); break; }
      const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null;
      const panelMsg = ch ? await ch.messages.fetch(panelId).catch(()=>null) : null;
      if (!panelMsg) { await dmOnly(i, '⚠️ Este turno ya no está disponible.'); return; }

      const pending = pendings.get(panelId);
      if (!pending || pending.nonce !== nonce) { await dmOnly(i, '⚠️ Este turno ya no está disponible.'); return; }
      if (i.user.id !== pending.userId) { await dmOnly(i, '⛔ Este aviso no es para vos.'); return; }

      const plan = planByChannel.get(panelMsg.channel.id);
      if (!plan) { try { await i.deferUpdate(); } catch {} return; }
      const slot = plan[idx];

      if (kind === 'ok') {
        // BLOQUEO GLOBAL antes de activar
        const conflict = findGlobalConflict(i.user.id, panelId);
        if (conflict) {
          clearPending(panelId);
          await promoteNext(panelMsg, slot, idx);
          const d = await describePanel(conflict.panelId);
          await dmOnly(i, `⛔ No podés confirmar porque estás **${conflict.type}** en ${d.text}` + (d.url ? `.\nPanel: ${d.url}` : '.'));
          return;
        }

        // safety: cooldown por si acaso
        const [inCd, rem] = hasCooldown(panelMsg.channel.id, idx, i.user.id);
        if (inCd) {
          clearPending(panelId);
          await promoteNext(panelMsg, slot, idx);
          await dmOnly(i, `⛔ Estás en cooldown en ${whereStr(panelMsg, slot.title)}. Te quedan **${fmtRemain(rem)}**.`);
          return;
        }

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

        sess.endTO = setTimeout(async ()=>{
          stopSessionById(panelId);
          await promoteNext(panelMsg, slot, idx);
          await dmUser(i.user.id, { content: `⏱️ Tu tiempo en ${whereStr(panelMsg, slot.title)} terminó.` });
        }, minutesSel * 60 * 1000);

        await dmOnly(i, `✅ Confirmado: **${minutesSel}m** en ${whereStr(panelMsg, slot.title)}.\nPanel: ${jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)}`);
      } else {
        clearPending(panelId);
        await promoteNext(panelMsg, slot, idx);
        await dmOnly(i, `❎ Rechazaste el turno en ${whereStr(panelMsg, slot.title)}.`);
      }
      return;
    }
  }

  // C) Panel principal (minutos / cancelar) — SOLO en canal de guild
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
    const pending = pendings.get(panelId);

    // cancelar activo (APLICA COOLDOWN + limpia interval/timeout)
    if (sess && i.user.id === sess.ownerId) {
      stopSessionById(panelId);
      await promoteNext(panelMsg, slot, idx);
      applyCooldown(ch.id, idx, i.user.id);
      await dmOnly(i, `🛑 Cancelaste tu tiempo en ${whereStr(panelMsg, slot.title)}.\nQuedás en **cooldown ${COOLDOWN_LABEL}** para este slot.`);
      return;
    }
    // cancelar pendiente (NO aplica cooldown)
    if (pending && pending.userId === i.user.id) {
      clearPending(panelId);
      await promoteNext(panelMsg, slot, idx);
      await dmOnly(i, `✅ Cancelaste tu turno pendiente en ${whereStr(panelMsg, slot.title)}.`);
      return;
    }
    // cancelar posición en cola (NO aplica cooldown)
    if (pos !== -1) {
      queue.splice(pos, 1);
      await refreshPanel(panelMsg, idx, slot);
      await dmOnly(i, `✅ Saliste de la sala de espera de ${whereStr(panelMsg, slot.title)}.`);
      return;
    }
    await dmOnly(i, `⚠️ No tenés nada para cancelar en ${whereStr(panelMsg, slot.title)}.`);
    return;
  }

  // iniciar / unirse a cola (chequear COOLDOWN y BLOQUEO GLOBAL)
  const minutesSel = parseInt(mm[2], 10);
  const minutesList = slot.minutes;
  if (!minutesList.includes(minutesSel)) { try { await i.deferUpdate(); } catch{} return; }

  // Bloqueo global: ¿ya participa en otro panel?
  const conflict = findGlobalConflict(i.user.id, panelId);
  if (conflict) {
    const d = await describePanel(conflict.panelId);
    await dmOnly(i,
      `⛔ No podés tomar otra sala: estás **${conflict.type}** en ${d.text}` +
      (d.url ? `.\nPanel: ${d.url}` : '.')
    );
    return;
  }

  // Cooldown por cancelación (del mismo slot)
  const [inCd, rem] = hasCooldown(ch.id, idx, i.user.id);
  if (inCd) {
    await dmOnly(i, `⛔ Tenés cooldown en ${whereStr(panelMsg, slot.title)}. Te quedan **${fmtRemain(rem)}**.\nPanel: ${jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)}`);
    return;
  }

  const queue = getQueue(panelId);
  const alreadyActive  = sessions.get(panelId)?.ownerId === i.user.id;
  const alreadyPending = pendings.get(panelId)?.userId === i.user.id;
  const alreadyInQueue = inQueue(queue, i.user.id) !== -1;

  if (alreadyActive || alreadyPending || alreadyInQueue) {
    await dmOnly(i, `⚠️ Ya estás participando de ${whereStr(panelMsg, slot.title)}.\nPanel: ${jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)}`);
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

    sess.endTO = setTimeout(async ()=>{
      stopSessionById(panelId);
      await promoteNext(panelMsg, slot, idx);
      await dmUser(i.user.id, { content: `⏱️ Tu tiempo en ${whereStr(panelMsg, slot.title)} terminó.` });
    }, minutesSel*60*1000);

    await dmOnly(i, `✅ Empezaste **${minutesSel}m** en ${whereStr(panelMsg, slot.title)}.\nPanel: ${jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)}`);
    return;
  }

  // ocupado o hay pendiente -> cola
  if (queue.length >= QUEUE_CAPACITY) {
    await dmOnly(i, `⛔ La sala de espera de ${whereStr(panelMsg, slot.title)} está llena (capacidad ${QUEUE_CAPACITY}).\nPanel: ${jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)}`);
    return;
  }
  queue.push({ userId: i.user.id, minutes: minutesSel, enqueuedAt: Date.now(), tag: i.user.tag });
  await refreshPanel(panelMsg, idx, slot);
  await dmOnly(i, `🕒 Entraste a la sala de espera de ${whereStr(panelMsg, slot.title)} por **${minutesSel}m**.\nPosición actual: **${queue.length}**.\nPanel: ${jumpLink(panelMsg.guildId, panelMsg.channelId, panelMsg.id)}`, [dmQueueRow(panelMsg)]);
});

/* ---------- manejo de señales (limpio) ---------- */
function shutdown(signal) {
  console.log(`🛑 Recibí ${signal}, cerrando...`);
  try { client.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

/* ---------- login (ENV en Koyeb) ---------- */
const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
if (!token) { console.error('❌ Falta TOKEN (o DISCORD_TOKEN) en variables de entorno de Koyeb.'); process.exit(1); }
client.login(token);
