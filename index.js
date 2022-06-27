const { getModule } = require('powercord/webpack');
const { forceUpdateElement } = require('powercord/util');
const { inject, uninject } = require('powercord/injector');
const { Plugin } = require('powercord/entities');

module.exports = class MentionCacheFix extends Plugin {
	async startPlugin() {
		this.checkingMessages = new Set();
		this.cachedMembers = new Set();

		this.fetchProfile = (await getModule(['getUser'])).fetchProfile;
		this.getMember = (await getModule(['getMember'])).getMember;
		this.getUser = (await getModule(['getUser'])).getUser;
		this.getGuildId = (
			await getModule(['getLastSelectedGuildId'])
		).getGuildId;

		this.injectUserMentions();
		this.injectMessage();
	}

	pluginWillUnload() {
		uninject('mcf-slate-user-mentions');
		uninject('mcf-message');
	}

	isCached(id) {
		let guildId =  this.getGuildId();
		return this.cachedMembers.has(`${id}-${guildId}`)
		|| this.cachedMembers.has(`${id}-*`)
		|| !!this.getMember(guildId, id);
	}

	fetchUser(id, retry = false) {
		if (this.isCached(id)) return;
		console.log(`START ${id}`);
		let guildId =  this.getGuildId();
		let fn = retry ? this.getUser(id) : this.fetchProfile(id, { guildId, withMutualGuilds: false });
		return fn.then(() => {
			this.cachedMembers.add(`${id}-${retry ? '*' : guildId}`);
			return;
		}).catch(e => {
			if (e && e.status === 429) return true; // Abort if ratelimited
			else if (e?.status === 403 && !retry) return this.fetchUser(id, true);
			else this.cachedMembers.add(`${id}-${retry ? '*' : guildId}`);

			return;
		});
	}

	async processMessage(message) {
		const matches = this.getMatches(message);
		if (!matches) return;

		for (let id of matches) {
			let abort = await this.fetchUser(id);
			this.update(message.id);
			if (abort) break;
		}
	}

	update(id) {
		forceUpdateElement(`#chat-messages-${id} .contents-2MsGLg`, true);
		forceUpdateElement(`#message-accessories-${id} > article`, true);
	}

	getMatches(message) {
		const content = [message.content];
		message.embeds.forEach(embed => {
			content.push(embed.rawDescription || '');
			if (embed.fields)
				embed.fields.forEach(field => content.push(field.rawValue));
		});
		const matches = [...content.join(' ').matchAll(/<@!?(\d+)>/g)]
			.map(m => m[1])
			.filter((id, i, arr) => arr.indexOf(id) === i);

		if (matches.length === 0) return null;

		return matches.filter(id => !this.isCached(id));
	}

	async injectUserMentions() {
		const SlateMention = await getModule(['UserMention']);

		inject(
			'mcf-slate-user-mentions',
			SlateMention,
			'UserMention',
			([{ id }], res) => {
				this.fetchUser(id);

				return res;
			},
		);
	}

	async injectMessage() {
		const Message = await getModule(
			m => m.default?.displayName === 'Message',
		);

		inject('mcf-message', Message, 'default', ([props], res) => {
			const message = props.childrenMessageContent.props.message;
			if (!message) return res;

			const el = document.getElementById(`chat-messages-${message.id}`);
			if (!el) return res;

			el.addEventListener('mouseleave', async () => {
				if (!this.checkingMessages.has(message.id)) return;
				this.checkingMessages.delete(message.id);

				this.update(message.id);
			});

			el.addEventListener(
				'mouseenter',
				async () => {
					if (this.checkingMessages.has(message.id)) return;
					this.checkingMessages.add(message.id);

					this.update(message.id);
					await this.processMessage(message);
				},
				true,
			);

			return res;
		});

		Message.default.displayName = 'Message';
	}
};
