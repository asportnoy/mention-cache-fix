/* eslint-disable @typescript-eslint/naming-convention */
import { Channel, GuildMember, Message, User } from "discord-types/general";
import type React from "react";
import { Injector, Logger, common, util, webpack } from "replugged";

const { forceUpdateElement } = util;
const {
  guilds: { getGuildId },
  users: { getUser, getTrueMember },
  api,
} = common;

const inject = new Injector();
const logger = Logger.plugin("MentionCacheFix");

interface Profile {
  connected_accounts?: Array<{
    type: string;
    id: string;
    name: string;
    verified: boolean;
  }>;
  user: User;
  user_profile: {
    accent_color?: number;
    bio?: string;
  };
  guild_member?: GuildMember;
  guild_member_profile?: {
    guild_id: string;
    accent_color: number | null;
    bio: string | null;
  };
}

let topicClass: string;
let messageContentClass: string;

const cachedMembers = new Set<string>();
const checkingMessages = new Set<string>();

function isCached(id: string, noGuild = false): boolean {
  const guildId = getGuildId();
  if (!guildId) return true;
  if (noGuild) {
    if (getUser(id)) return true;
  } else if (getTrueMember(guildId, id)) return true;

  return cachedMembers.has(`${id}-${guildId}`);
}

async function fetchUser(id: string): Promise<{ user: User }> {
  const res = await api.get<User>({
    url: `/users/${id}`,
  });
  const { body } = res;
  common.fluxDispatcher.dispatch({ type: "USER_UPDATE", user: body });
  return { user: body };
}

async function fetchMember(id: string, guild_id: string): Promise<Profile> {
  const res = await api.get<Profile>({
    url: `/users/${id}/profile`,
    query: {
      with_mutual_friends_count: "false",
      with_mutual_guilds: "false",
      guild_id,
    },
  });
  const { body } = res;
  common.fluxDispatcher.dispatch({ type: "USER_UPDATE", user: body.user });
  if (body.guild_member) {
    common.fluxDispatcher.dispatch({
      type: "GUILD_MEMBER_PROFILE_UPDATE",
      guildId: guild_id,
      guildMember: body.guild_member,
    });
  }

  return body;
}

function fetchProfile(id: string, retry = false): void | Promise<boolean | void> {
  const guildId = getGuildId();
  if (!guildId) return;
  if (isCached(id, retry)) {
    cachedMembers.add(`${id}-${guildId}`);
    return;
  }
  const fn = retry ? fetchUser(id) : fetchMember(id, guildId);

  return fn
    .then((x) => {
      if (retry || (!retry && !("guild_member" in x))) cachedMembers.add(`${id}-${guildId}`);
      return false;
    })
    .catch((e) => {
      if (e && e.status === 429) {
        // Abort if rate limited
        logger.error(`Aborted while fetching user ${id} due to rate limit`);
        return true;
      } else if (e && e.status === 403 && !retry) {
        return fetchProfile(id, true);
      } else {
        cachedMembers.add(`${id}-${guildId}`);
      }
    });
}

async function processMatches(matches: string[], updateInfo: "topic" | string): Promise<void> {
  for (const id of matches) {
    const abort = await fetchProfile(id);
    if (abort) break;
    update(updateInfo);
  }
}

function update(updateInfo: "topic" | string): void {
  switch (updateInfo) {
    case "topic":
      forceUpdateElement(`.${topicClass}`, true);
      break;
    default: // Message
      forceUpdateElement(`#chat-messages-${updateInfo} .${messageContentClass}`, true);
      forceUpdateElement(`#message-accessories-${updateInfo} > article`, true);
  }
}

function getIDsFromText(text: string): string[] {
  return [...text.matchAll(/<@!?(\d+)>/g)]
    .map((m) => m[1])
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .filter((id) => !isCached(id));
}

function getMatches(message: Message): string[] {
  const content: string[] = [message.content];
  message.embeds.forEach((embed) => {
    content.push(embed.rawDescription || "");
    if (embed.fields)
      (embed.fields as Array<Record<string, unknown> & { rawValue: string }>).forEach((field) =>
        content.push(field.rawValue),
      );
  });
  return getIDsFromText(content.join(" "));
}

function getMessageIdentifier(message: Message): string {
  return `${message.id}-${message.editedTimestamp?.unix()}`;
}

export async function start(): Promise<void> {
  const messageComponent = (
    await webpack.waitForModule(webpack.filters.bySource(".content.id)"), { raw: true })
  ).exports as {
    Z: React.FC & {
      type: (props: Record<string, unknown> & { channel: Channel }) => React.FC;
    };
  };
  if (!messageComponent) {
    throw new Error("Failed to find message component");
  }

  const topicClassMod = await webpack.waitForModule<{ topic: string }>(
    webpack.filters.byProps("topic", "topicClickTarget"),
  );
  if (!topicClassMod) {
    throw new Error("Failed to find topic class mod");
  }
  topicClass = topicClassMod.topic;

  const messageContentClassMod = await webpack.waitForModule<{ contents: string }>(
    webpack.filters.byProps("contents", "messageContent"),
  );
  if (!messageContentClassMod) {
    throw new Error("Failed to find message content class mod");
  }
  messageContentClass = messageContentClassMod.contents;

  inject.after(messageComponent.Z, "type", ([{ channel }], res) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
    // @ts-ignore I'm too lazy to type this
    const messages: Message[] = res.props.children.props.messages._array;

    const topicIdentifier = `${channel.id}-${channel.topic}`;
    if (!checkingMessages.has(topicIdentifier)) {
      checkingMessages.add(topicIdentifier);

      update("topic");

      const matches = getIDsFromText(channel.topic);
      void processMatches(matches, "topic").then(() => checkingMessages.delete(topicIdentifier));
    }

    setTimeout(
      () =>
        messages.forEach((message) => {
          const el = document.getElementById(`chat-messages-${message.channel_id}-${message.id}`);
          if (!el) return res;

          el.addEventListener("mouseleave", () => {
            const identifier = getMessageIdentifier(message);
            if (!checkingMessages.has(identifier)) return;
            checkingMessages.delete(identifier);

            update(message.id);
          });

          el.addEventListener(
            "mouseenter",
            () => {
              const identifier = getMessageIdentifier(message);
              if (checkingMessages.has(identifier)) return;
              checkingMessages.add(identifier);

              update(message.id);

              const matches = getMatches(message);
              void processMatches(matches, message.id).then(() =>
                checkingMessages.delete(identifier),
              );
            },
            true,
          );
        }),
      0,
    );
  });
}

export function stop(): void {
  inject.uninjectAll();
}
