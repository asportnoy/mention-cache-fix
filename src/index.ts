/* eslint-disable @typescript-eslint/naming-convention */
import { GuildMember, Message, User } from "discord-types/general";
import type React from "react";
import { Injector, common, logger, util, webpack } from "replugged";

const inject = new Injector();

type GetMember = Record<string, unknown> & {
  getTrueMember: (guildId: string, userId: string) => GuildMember;
};

type UserMod = Record<string, unknown> & {
  getUser: (userId: string) => User | undefined;
  getCurrentUser: () => User;
};

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

type APIMod = Record<
  "get" | "patch" | "post" | "put" | "delete",
  <T = Record<string, unknown>>(req: {
    url: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) => Promise<{
    body: T;
    status: number;
    headers: Record<string, string>;
    ok: boolean;
    text: string;
  }>
> & {
  getAPIBaseURL: () => string;
};

// todo: remove once typed correctly
type Dispatcher = Record<string, unknown> & {
  dispatch: (action: Record<string, unknown> & { type: string }) => void;
};

const { getGuildId } = common.guilds;
let getMember: GetMember["getTrueMember"];
let getUser: UserMod["getUser"];
let api: APIMod;

const cachedMembers = new Set<string>();
const checkingMessages = new Set<string>();

function isCached(id: string, noGuild = false): boolean {
  const guildId = getGuildId();
  if (!guildId) return true;
  if (noGuild) {
    if (getUser(id)) return true;
  } else if (getMember(guildId, id)) return true;

  return cachedMembers.has(`${id}-${guildId}`);
}

function forceUpdateElement(query: string, all = false): void {
  const elements = (
    all ? [...document.querySelectorAll(query)] : [document.querySelector(query)]
  ).filter(Boolean) as Element[];
  elements.forEach((element) => {
    (
      util.getOwnerInstance(element) as
        | (Record<string, unknown> & { forceUpdate: () => void })
        | null
    )?.forceUpdate();
  });
}

async function fetchUser(id: string): Promise<{ user: User }> {
  const res = await api.get<User>({
    url: `/users/${id}`,
  });
  const { body } = res;
  (common.fluxDispatcher as Dispatcher).dispatch({ type: "USER_UPDATE", user: body });
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
  (common.fluxDispatcher as Dispatcher).dispatch({ type: "USER_UPDATE", user: body.user });
  if (body.guild_member) {
    (common.fluxDispatcher as Dispatcher).dispatch({
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
        logger.error(
          "MentionCacheFix",
          "Fetching",
          undefined,
          `Aborted while fetching user ${id} due to rate limit`,
        );
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
      forceUpdateElement(".topic-11NuQZ", true);
      break;
    default: // Message
      forceUpdateElement(`#chat-messages-${updateInfo} .contents-2MsGLg`, true);
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
  const getMemberModRaw = await webpack.waitForModule(
    webpack.filters.byProps("getTrueMember", "getMember"),
  );
  const getMemberMod = webpack.getExportsForProps<"getTrueMember", GetMember>(getMemberModRaw, [
    "getTrueMember",
  ])!;
  getMember = getMemberMod.getTrueMember;

  const userMod = await webpack.waitForModule<UserMod>(
    webpack.filters.byProps("getUser", "getCurrentUser"),
  );
  getUser = userMod.getUser;

  const messageComponent = (await webpack.waitForModule(
    webpack.filters.bySource(".content.id)"),
  )) as React.FC & {
    type: (props: Record<string, unknown>) => React.FC;
  };
  if (!messageComponent) {
    throw new Error("Failed to find message component");
  }

  api = webpack.getByProps<keyof APIMod, APIMod>(
    "getAPIBaseURL",
    "get",
    "patch",
    "post",
    "put",
    "delete",
  )!;
  if (!api) {
    throw new Error("Failed to find api mod");
  }

  inject.after(messageComponent, "type", (_args, res) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
    // @ts-ignore I'm too lazy to type this
    const messages: Message[] = res.props.children.props.messages._array;

    messages.forEach((message) => {
      const el = document.getElementById(`chat-messages-${message.id}`);
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
          void processMatches(matches, message.id);
        },
        true,
      );
    });
  });
}

export function stop(): void {
  inject.uninjectAll();
}
