/**
 * Which icon each rail item draws, by the `icon` key `mock.ts` gives it.
 *
 * Shared by the rail and the section crumb, which lists the same items when the rail is
 * hidden: two maps would let the same section wear two different icons.
 */
import {
  IconBlocked,
  IconClipboard,
  IconCube,
  IconEye,
  IconGoal,
  IconList,
  IconRobot,
  IconSearch,
  IconUser,
} from "./icons";

export const navGlyphs: Record<string, typeof IconGoal> = {
  goals: IconGoal,
  findings: IconSearch,
  observations: IconEye,
  assets: IconCube,
  evidence: IconClipboard,
  workers: IconUser,
  blockers: IconBlocked,
  events: IconList,
  "agent-sessions": IconRobot,
};
