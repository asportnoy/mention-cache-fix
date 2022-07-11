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
		this.parse = await getModule(['parse', 'parseTopic']);

		this.injectUserMentions();
		this.injectMessage();
		this.injectTopic();
	}

	pluginWillUnload() {
		uninject('mcf-slate-user-mentions');
		uninject('mcf-message');
		uninject('mcf-parsetopic');
	}

	isCached(id) {
		let guildId = this.getGuildId();
		return this.cachedMembers.has(`${id}-${guildId}`) || !!this.getMember(guildId, id);
	}

	fetchUser(id, retry = false) {
		if (this.isCached(id)) return;
		let guildId =  this.getGuildId();
		let fn = retry ? this.getUser(id) : this.fetchProfile(id, { guildId, withMutualGuilds: false });
		return fn
			.then(() => false)
			.catch(e => {
				if (e && e.status === 429) return true; // Abort if ratelimited
				else if (e?.status === 403 && !retry) return this.fetchUser(id, true);
				else this.cachedMembers.add(`${id}-${guildId}`);

				return;
			});
	}

	async processMatches(matches, updateInfo) {
		for (let id of matches) {
			let abort = await this.fetchUser(id);
			if (abort) break;
			this.update(updateInfo);
		}
	}

	update(updateInfo) {
		switch (updateInfo) {
			case 'topic':
				forceUpdateElement('.topic-11NuQZ', true);
				break;
			default: // Message
				forceUpdateElement(`#chat-messages-${updateInfo} .contents-2MsGLg`, true);
				forceUpdateElement(`#message-accessories-${updateInfo} > article`, true);		}
	}

	getIDsFromText(text) {
		return [...text.matchAll(/<@!?(\d+)>/g)]
			.map(m => m[1])
			.filter((id, i, arr) => arr.indexOf(id) === i)
			.filter(id => !this.isCached(id));
	}

	getMatches(message) {
		const content = [message.content];
		message.embeds.forEach(embed => {
			content.push(embed.rawDescription || '');
			if (embed.fields)
				embed.fields.forEach(field => content.push(field.rawValue));
		});
		return this.getIDsFromText(content.join(' '));
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

					const matches = this.getMatches(message);
					this.processMatches(matches, message.id);
				},
				true,
			);

			return res;
		});

		Message.default.displayName = 'Message';
	}

	async injectTopic() {
		inject('mcf-parsetopic', this.parse, 'parseTopic', ([content], res) => {
			const matches = this.getIDsFromText(content);
			this.processMatches(matches, 'topic');
			return res;
		});
	}
};
