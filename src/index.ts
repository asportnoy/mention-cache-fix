/* eslint-disable @typescript-eslint/naming-convention */
import { Channel, GuildMember, Message, User } from "discord-types/general";
import type React from "react";
import { Injector, Logger } from "replugged";
import { filters, waitForModule, waitForProps } from "replugged/webpack";
import { api, fluxDispatcher, guilds, users } from "replugged/common";
import { forceUpdateElement } from "replugged/util";

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
  const guildId = guilds.getGuildId();
  if (!guildId) return true;
  if (noGuild) {
    if (users.getUser(id)) return true;
  } else if (users.getTrueMember(guildId, id)) return true;

  return cachedMembers.has(`${id}-${guildId}`);
}

async function fetchUser(id: string): Promise<{ user: User }> {
  const res = await api.HTTP.get<User>({
    url: `/users/${id}`,
  });
  const { body } = res;
  fluxDispatcher.dispatch({ type: "USER_UPDATE", user: body });
  return { user: body };
}

async function fetchMember(id: string, guild_id: string): Promise<Profile> {
  const res = await api.HTTP.get<Profile>({
    url: `/users/${id}/profile`,
    query: {
      with_mutual_friends_count: "false",
      with_mutual_guilds: "false",
      guild_id,
    },
  });
  const { body } = res;
  fluxDispatcher.dispatch({ type: "USER_UPDATE", user: body.user });
  if (body.guild_member) {
    fluxDispatcher.dispatch({
      type: "GUILD_MEMBER_PROFILE_UPDATE",
      guildId: guild_id,
      guildMember: body.guild_member,
    });
  }

  return body;
}

function fetchProfile(id: string, retry = false): void | Promise<boolean | void> {
  const guildId = guilds.getGuildId();
  if (!guildId) return;
  if (isCached(id, retry)) {
    cachedMembers.add(`${id}-${guildId}`);
    return;
  }
  const fn = retry ? fetchUser(id) : fetchMember(id, guildId);

  return fn
    .then((x) => {
      if (retry || !("guild_member" in x)) cachedMembers.add(`${id}-${guildId}`);
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (embed.fields)
      (embed.fields as Array<Record<string, unknown> & { rawValue: string }>).forEach((field) =>
        content.push(field.rawValue),
      );
  });

  return getIDsFromText(content.join(" "));
}

function getMessageIdentifier(message: Message): string {
  // @ts-expect-error This is no longer a moment instance
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const timestamp: Date = message.editedTimestamp ?? message.timestamp;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!timestamp) console.log(message);

  return `${message.id}-${Math.floor(timestamp.getTime() / 1000)}`;
}

export async function start(): Promise<void> {
  const messageComponent = await waitForModule<{
    exports: {
      default: (
        props: React.HTMLAttributes<HTMLDivElement> & {
          childrenMessageContent?: { props: { message?: Message } };
          messageRef?: { current?: HTMLDivElement };
        },
      ) => React.FC;
    };
  }>(filters.bySource(/childrenMessageContent:\w,childrenAccessories:\w,/), { raw: true });

  const topicComponent = await waitForModule<
    React.Component & {
      prototype: {
        render: (this: {
          props: {
            channel: Channel;
          };
        }) => React.ReactElement;
      };
    }
  >(filters.bySource(/null==\w.topic/));

  const topicClassMod = await waitForProps<{ topic: string; topicClickTarget: string }>(
    "topic",
    "topicClickTarget",
  );
  topicClass = topicClassMod.topic;

  const messageContentClassMod = await waitForProps<{
    contents: string;
    messageContent: string;
  }>("contents", "messageContent");
  messageContentClass = messageContentClassMod.contents;

  inject.before(messageComponent.exports, "default", ([props]) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
    // @ts-ignore I'm too lazy to type this

    const message = props.childrenMessageContent?.props.message;
    if (!message) return;
    const el = props.messageRef?.current;
    if (!el) return;

    const { onMouseEnter: originalOnMouseEnter, onMouseLeave: originalOnMouseLeave } = props;

    props.onMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
      originalOnMouseEnter?.(e);

      const identifier = getMessageIdentifier(message);
      if (checkingMessages.has(identifier)) return;
      checkingMessages.add(identifier);

      update(message.id);

      const matches = getMatches(message);
      void processMatches(matches, message.id).then(() => checkingMessages.delete(identifier));
    };

    props.onMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
      originalOnMouseLeave?.(e);

      const identifier = getMessageIdentifier(message);
      if (!checkingMessages.has(identifier)) return;
      checkingMessages.delete(identifier);

      update(message.id);
    };
  });

  inject.after(topicComponent.prototype, "render", (_props, _res, self) => {
    const { channel } = self.props as { channel: Channel };

    const topicIdentifier = `${channel.id}-${channel.topic}`;
    if (!checkingMessages.has(topicIdentifier)) {
      checkingMessages.add(topicIdentifier);

      update("topic");

      const matches = getIDsFromText(channel.topic);
      void processMatches(matches, "topic").then(() => checkingMessages.delete(topicIdentifier));
    }
  });
}

export function stop(): void {
  inject.uninjectAll();
}
