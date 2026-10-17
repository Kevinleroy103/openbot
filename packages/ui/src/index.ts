/**
 * @openbot/ui — OpenBot design system: generated tokens (tokens.css / styles.css), primitives, avatars,
 * icon wrapper. Pure presentation: no data fetching (architecture §2, §4.10).
 */
export { cn } from "./cn.ts"
export { Icon, iconSizes, type IconProps, type IconSize } from "./Icon.tsx"

// Avatars
export {
  AvatarColors,
  AvatarShapes,
  AvatarExpressions,
  type AvatarColor,
  type AvatarShape,
  type AvatarExpression,
  fnv1a32,
  defaultBotAvatar,
  normalizeAvatar,
  isAvatarColor,
  isAvatarShape,
  avatarFill,
  avatarHue,
  botTintStyle,
} from "./avatar/palette.ts"
export { avatarBodies, type AvatarBody } from "./avatar/shapes.ts"
export { Avatar, AvatarStack, type AvatarProps, type AvatarStackProps, type AvatarSize, type AvatarStatus, type AvatarGaze } from "./avatar/Avatar.tsx"
export { AvatarPicker, type AvatarPickerProps } from "./avatar/AvatarPicker.tsx"

// Buttons
export {
  Spinner,
  IconButton,
  PillButton,
  HeaderPill,
  type IconButtonProps,
  type IconButtonSize,
  type IconButtonVariant,
  type PillButtonProps,
  type PillButtonSize,
  type PillButtonVariant,
  type HeaderPillProps,
} from "./primitives/buttons.tsx"

// Chat
export {
  Bubble,
  BubbleGroup,
  bubbleCorners,
  bubbleCornerClass,
  groupPosition,
  EventLine,
  EventChip,
  Timestamp,
  NewDivider,
  ShimmerText,
  ActivityRow,
  TypingDots,
  LabelChip,
  CountBadge,
  UnreadDot,
  type BubbleProps,
  type BubbleSide,
  type BubblePosition,
  type EventChipProps,
} from "./primitives/chat.tsx"

// Cards
export {
  Card,
  CardHeader,
  CardBody,
  CardLink,
  CardActions,
  Sheet,
  SheetRow,
  SheetField,
  OptionRow,
  KeyBadge,
  StatusPill,
  type CardProps,
  type CardHeaderProps,
  type SheetRowProps,
  type KeyBadgeProps,
  type StatusPillProps,
  type StatusTone,
} from "./primitives/card.tsx"

// Forms
export {
  TextField,
  TextArea,
  Switch,
  SegmentedTabs,
  type TextFieldProps,
  type TextAreaProps,
  type SwitchProps,
  type SegmentedTab,
  type SegmentedTabsProps,
} from "./primitives/forms.tsx"

// Overlays
export {
  Portal,
  placePanel,
  Popover,
  Menu,
  MenuPanel,
  MenuItem,
  MenuSeparator,
  MenuLabel,
  Select,
  Tooltip,
  TooltipSurface,
  Dialog,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  Toast,
  Toaster,
  useToast,
  CommandPalette,
  CommandPaletteBody,
  filterPaletteItems,
  type Side,
  type Align,
  type Rect,
  type TriggerProps,
  type PopoverProps,
  type MenuProps,
  type MenuItemProps,
  type SelectProps,
  type SelectOption,
  type TooltipProps,
  type DialogProps,
  type DialogPanelProps,
  type ToastData,
  type ToastTone,
  type PaletteItem,
  type CommandPaletteProps,
} from "./primitives/overlay.tsx"
