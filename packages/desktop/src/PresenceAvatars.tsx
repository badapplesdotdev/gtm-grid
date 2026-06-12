/**
 * The live-users avatar stack shown in the cloud grid toolbar. Renders the
 * deduped, self-excluded roster from {@link GridPresenceView} on shadcn's
 * {@link AvatarStack} / {@link Avatar} primitives: up to {@link MAX_VISIBLE}
 * overlapping avatars plus a `+N` overflow chip. Hovering an avatar reveals the
 * member's name (shadcn Tooltip) and a "click to follow" hint when they have a
 * cursor; clicking follows them — the grid scrolls to their current cell.
 */

import type { PresenceUser } from "./gridPresence";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import { AvatarStack } from "./components/ui/avatar-stack";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";

/** How many avatars to show before collapsing the rest into a `+N` chip. */
const MAX_VISIBLE = 5;

const initial = (user: PresenceUser): string =>
  (user.name ?? "?").trim().slice(0, 1).toUpperCase() || "?";

/** The agent's bot glyph (no photo) — sized for the 24px stacked avatar. */
export function BotGlyph({ size = 13, color }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  );
}

/** One stacked avatar: surface-ring separator + per-user color ring, name on hover. */
function PresenceAvatar({
  user,
  onJump,
}: {
  user: PresenceUser;
  onJump: (user: PresenceUser) => void;
}) {
  // You can't follow yourself; only a remote member with a cursor is followable.
  const followable = !user.isSelf && user.cursor !== null;
  const label = user.isSelf
    ? user.name
      ? `${user.name} (you)`
      : "You"
    : (user.name ?? user.userId);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => { if (followable) onJump(user); }}
          className={`relative outline-none transition-transform hover:z-10 hover:-translate-y-0.5 ${followable ? "cursor-pointer" : "cursor-default"}`}
        >
          <Avatar
            className="size-[24px] border-2 border-background"
            style={{ boxShadow: `0 0 0 1.5px ${user.color}` }}
          >
            {!user.isAgent && user.image !== null && (
              <AvatarImage src={user.image} alt="" referrerPolicy="no-referrer" />
            )}
            <AvatarFallback
              className="text-[11px] font-bold"
              style={{ color: user.color }}
            >
              {user.isAgent ? <BotGlyph color={user.color} /> : initial(user)}
            </AvatarFallback>
          </Avatar>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-semibold">{label}</span>
        {user.isAgent && user.activity !== null && (
          <span className="opacity-70"> — {user.activity}</span>
        )}
        {followable && <span className="opacity-70"> · click to follow</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function PresenceAvatars({
  users,
  onJump,
}: {
  users: readonly PresenceUser[];
  onJump: (user: PresenceUser) => void;
}) {
  if (users.length === 0) return null;
  const visible = users.slice(0, MAX_VISIBLE);
  const overflow = users.slice(MAX_VISIBLE);
  return (
    <div
      className="flex items-center gap-1.5 pl-2"
      aria-label={`${users.length} online`}
    >
      <AvatarStack>
        {visible.map((user) => (
          <PresenceAvatar key={user.key} user={user} onJump={onJump} />
        ))}
      </AvatarStack>
      {overflow.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="cursor-default text-xs font-medium text-muted-foreground outline-none hover:text-foreground"
            >
              +{overflow.length} more
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {overflow.map((u) => (
              <div key={u.key}>{u.name ?? u.userId}</div>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
