// queueManager.js
const {
  Collection,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

/**
 * Estructura por slot:
 * state = {
 *   active: { userId, minutes, startedAt, expiresAt } | null
 *   waitlist: [{ userId, minutes, enqueuedAt }]
 *   pending: { userId, minutes, nonce, deadline, timeout, messageId } | null
 *   timeout: NodeJS.Timeout | null // del activo
 *   lock: boolean
 * }
 */
class QueueManager {
  constructor({ client, config }) {
    this.client = client;
    this.config = config;
    this.queueCapacity = config.queueCapacity ?? 2;
    this.notifyChannelId = config.notifyChannelId;
    this.confirmWindowSec = config.confirmWindowSec ?? 45;
    this.states = new Collection(); // key: `${profile}::${slotTitle}`
  }

  key(profile, slotTitle) {
    return `${profile}::${slotTitle}`;
  }

  _getState(key) {
    if (!this.states.has(key)) {
      this.states.set(key, {
        active: null,
        waitlist: [],
        pending: null,
        timeout: null,
        lock: false
      });
    }
    return this.states.get(key);
  }

  _clearTimer(state) {
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = null;
  }

  _clearPending(state) {
    if (state.pending?.timeout) clearTimeout(state.pending.timeout);
    state.pending = null;
  }

  _startActiveTimer(key) {
    const state = this._getState(key);
    this._clearTimer(state);
    if (!state.active) return;
    const msLeft = Math.max(0, state.active.expiresAt - Date.now());
    state.timeout = setTimeout(() => this._onExpire(key), msLeft);
  }

  async _onExpire(key) {
    const state = this._getState(key);
    const finished = state.active;
    state.active = null;
    this._clearTimer(state);

    const channel = await this._getNotifyChannel();
    if (finished) {
      channel?.send(`⏱️ Se terminó el tiempo de <@${finished.userId}> en **${key}**.`);
    }
    await this._promoteNext(key);
  }

  async _promoteNext(key) {
    const state = this._getState(key);
    const channel = await this._getNotifyChannel();

    // Si ya hay pendiente, no promover otro
    if (state.pending) return;

    if (state.waitlist.length > 0) {
      const next = state.waitlist.shift(); // FIFO
      await this._askConfirmation(key, next.userId, next.minutes);
    } else {
      channel?.send(`🟢 **${key}** quedó libre.`);
    }
  }

  _nonce() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async _askConfirmation(key, userId, minutes) {
    const state = this._getState(key);
    const channel = await this._getNotifyChannel();
    const sec = Math.max(5, this.confirmWindowSec);
    const nonce = this._nonce();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`claim-confirm:${key}:${userId}:${nonce}`)
        .setLabel("Confirmar")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`claim-decline:${key}:${userId}:${nonce}`)
        .setLabel("Rechazar")
        .setStyle(ButtonStyle.Danger)
    );

    const msg = await channel?.send({
      content: `🔔 <@${userId}>, es tu turno en **${key}** por **${minutes}m**.\nTenés **${sec}s** para confirmar, o perdés el turno.`,
      components: [row]
    });

    const timeout = setTimeout(() => this._onConfirmTimeout(key, nonce), sec * 1000);

    state.pending = {
      userId,
      minutes,
      nonce,
      deadline: Date.now() + sec * 1000,
      timeout,
      messageId: msg?.id ?? null
    };
  }

  async _onConfirmTimeout(key, nonce) {
    const state = this._getState(key);
    const channel = await this._getNotifyChannel();
    if (!state.pending || state.pending.nonce !== nonce) return; // ya manejado
    const lostUser = state.pending.userId;

    // Deshabilito botones del mensaje (si existe)
    if (state.pending.messageId && channel) {
      try {
        const m = await channel.messages.fetch(state.pending.messageId);
        await m.edit({ components: [] }).catch(() => {});
      } catch (_) {}
    }

    this._clearPending(state);
    channel?.send(`⌛ <@${lostUser}> no confirmó a tiempo en **${key}**. Pasando al siguiente…`);
    await this._promoteNext(key);
  }

  async _activate(key, userId, minutes, fromQueue = false) {
    const state = this._getState(key);
    const now = Date.now();
    state.active = {
      userId,
      minutes,
      startedAt: now,
      expiresAt: now + minutes * 60_000
    };
    this._startActiveTimer(key);

    const channel = await this._getNotifyChannel();
    channel?.send(
      `${fromQueue ? "▶️ Autoclaim" : "✅ Claim"}: <@${userId}> tiene **${minutes}m** en **${key}**. ` +
      `Termina <t:${Math.floor(state.active.expiresAt / 1000)}:R>.`
    );
  }

  async _getNotifyChannel() {
    if (!this.notifyChannelId) return null;
    try {
      const ch = await this.client.channels.fetch(this.notifyChannelId);
      return ch?.isTextBased() ? ch : null;
    } catch {
      return null;
    }
  }

  // =========== API pública ===========

  async claim({ profile, slotTitle, userId, minutes }) {
    const key = this.key(profile, slotTitle);
    const state = this._getState(key);

    if (state.lock) return { ok: false, reason: "busy" };
    state.lock = true;
    try {
      // Si no hay activo ni pendiente, activar directo
      if (!state.active && !state.pending) {
        await this._activate(key, userId, minutes, false);
        return { ok: true, mode: "active" };
      }

      // Ya hay algo en curso: ¿puede entrar en espera?
      if (state.waitlist.find(w => w.userId === userId) || state.pending?.userId === userId || state.active?.userId === userId) {
        return { ok: false, reason: "already_in_queue" };
      }
      if (state.waitlist.length >= this.queueCapacity) {
        return { ok: false, reason: "queue_full", capacity: this.queueCapacity };
      }
      state.waitlist.push({ userId, minutes, enqueuedAt: Date.now() });
      return { ok: true, mode: "queued", position: state.waitlist.length };
    } finally {
      state.lock = false;
    }
  }

  async release({ profile, slotTitle, userId }) {
    const key = this.key(profile, slotTitle);
    const state = this._getState(key);
    if (state.lock) return { ok: false, reason: "busy" };
    state.lock = true;
    try {
      // Si quien suelta es el activo
      if (state.active?.userId === userId) {
        await this._onExpire(key); // libera y promueve
        return { ok: true, released: "active" };
      }
      // Si está pendiente de confirmar, lo quitamos
      if (state.pending?.userId === userId) {
        this._clearPending(state);
        const ch = await this._getNotifyChannel();
        ch?.send(`❎ <@${userId}> canceló su turno pendiente en **${key}**.`);
        await this._promoteNext(key);
        return { ok: true, released: "pending" };
      }
      // Si está en la espera
      const idx = state.waitlist.findIndex(w => w.userId === userId);
      if (idx !== -1) {
        state.waitlist.splice(idx, 1);
        return { ok: true, released: "queue" };
      }
      return { ok: false, reason: "not_holding" };
    } finally {
      state.lock = false;
    }
  }

  status({ profile, slotTitle }) {
    const key = this.key(profile, slotTitle);
    const state = this._getState(key);
    return {
      active: state.active,
      pending: state.pending ? {
        userId: state.pending.userId,
        minutes: state.pending.minutes,
        deadline: state.pending.deadline
      } : null,
      queue: [...state.waitlist],
      capacity: this.queueCapacity
    };
  }

  /**
   * Botones "Confirmar / Rechazar" de la promoción desde cola
   */
  async handleButton(interaction) {
    if (!interaction.isButton()) return;
    const [kind, key, userId, nonce] = interaction.customId.split(":");
    if (kind !== "claim-confirm" && kind !== "claim-decline") return;

    const state = this._getState(key);
    if (!state.pending || state.pending.nonce !== nonce) {
      return interaction.reply({ ephemeral: true, content: "⚠️ Este turno ya no está disponible." });
    }

    // Sólo el usuario correcto puede operar
    if (interaction.user.id !== userId) {
      return interaction.reply({ ephemeral: true, content: "⛔ Este aviso no es para vos." });
    }

    // Deshabilito botones del mensaje
    try {
      if (state.pending.messageId) {
        const ch = await this._getNotifyChannel();
        const msg = ch ? await ch.messages.fetch(state.pending.messageId) : null;
        await msg?.edit({ components: [] }).catch(() => {});
      }
    } catch (_) {}

    if (kind === "claim-confirm") {
      const minutes = state.pending.minutes;
      this._clearPending(state);
      await this._activate(key, userId, minutes, true);
      return interaction.reply({ ephemeral: true, content: `✅ Confirmado. Tenés **${minutes}m**.` });
    } else {
      const declinedUser = state.pending.userId;
      this._clearPending(state);
      const ch = await this._getNotifyChannel();
      ch?.send(`❎ <@${declinedUser}> rechazó su turno en **${key}**. Pasando al siguiente…`);
      await this._promoteNext(key);
      return interaction.reply({ ephemeral: true, content: "Hecho. Saliste del turno." });
    }
  }
}

module.exports = { QueueManager };
