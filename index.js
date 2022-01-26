/*
 * Copyright (c) 2020 Bowser65
 * Licensed under the Open Software License version 3.0
 */

const {getModule} = require('powercord/webpack');
const {inject, uninject} = require('powercord/injector');
const {Plugin} = require('powercord/entities');

module.exports = class MentionCacheFix extends Plugin {
	async startPlugin() {
		this.checkingMessages = new Set();
		this.ignoreUsers = new Set();

		this.getCachedUser = (
			await getModule(['getCurrentUser', 'getUser'])
		).getUser;
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

	fetchUser(id) {
		return this.getUser(id).catch(e => {
			if (e && e.status == 429 && e.headers?.retry_after)
				return new Promise(resolve =>
					setTimeout(parseInt(e.headers.retry_after) * 1000, () =>
						resolve(this.fetchUser(id)),
					),
				);
			if (e && e.status == 403) ignoreUsers.add(id);
			if (e && e.status == 404) ignoreUsers.add(id);

			return;
		});
	}

	async injectUserMentions() {
		const SlateMention = await getModule(['UserMention']);

		inject(
			'mcf-slate-user-mentions',
			SlateMention,
			'UserMention',
			([{id}], res) => {
				let cachedUser = this.getCachedUser(id);
				if (!cachedUser) {
					this.fetchUser(id);
				}

				return res;
			},
		);
	}

	async injectMessage() {
		const Message = await getModule(
			m => m.default?.displayName == 'Message',
		);

		inject('mcf-message', Message, 'default', ([props], res) => {
			const message = props.childrenMessageContent.props.message;

			document
				.getElementById(`chat-messages-${message.id}`)
				?.addEventListener(
					'mouseenter',
					async () => {
						if (this.checkingMessages.has(message.id)) return;

						this.checkingMessages.add(message.id);

						const content = [message.content];
						message.embeds.forEach(embed => {
							content.push(embed.rawDescription || '');
							if (embed.fields)
								embed.fields.forEach(field =>
									content.push(field.rawValue),
								);
						});
						const matches = [
							...content.join(' ').matchAll(/<@!?(\d+)>/g),
						]
							.map(m => m[1])
							.filter((id, i, arr) => arr.indexOf(id) === i)
							.filter(id => !this.ignoreUsers.has(id));

						for (let id of matches) {
							let cachedUser = this.getCachedUser(id);
							if (!cachedUser) {
								await this.fetchUser(id);
							}
						}

						this.checkingMessages.remove(message.id);
					},
					true,
				);

			return res;
		});

		Message.default.displayName = 'Message';
	}
};
