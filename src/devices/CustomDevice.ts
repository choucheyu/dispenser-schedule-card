import {
  AmountConfig,
  Device,
  DeviceCapabilities,
  DeviceDisplayInfo,
  EditScheduleEntry,
  EntryFieldDescriptor,
  EntryFieldRole,
  EntryStatus,
  GlobalToggleInfo,
  ScheduleEntry,
} from "../types/common";
import { HomeAssistant } from "../types/ha";
import { ALL_WEEKDAYS, getTodayWeekday, Weekday } from "../types/weekday";
import { appliesOnWeekday } from "../types/scheduleWeekdays";

export interface ServiceCallActionConfig {
  add?: string;
  edit?: string;
  remove?: string;
  toggle?: string;
}

export interface CustomDeviceConfig {
  type: "custom";
  entity: string;
  status_pattern: string;
  status_map: Array<`${string} -> ${string}`>;
  max_entries: number;
  max_amount: number;
  min_amount: number;
  step_amount: number;
  switch?: string;
  actions?: ServiceCallActionConfig;
  /**
   * Optional name of an entity attribute holding a weekly feed plan list.
   * Defaults to "feed_daily_list" (Petkit). When the named attribute is
   * present and parseable, the device exposes a weekly schedule and the
   * raw `state` regex parsing is skipped. Set to `null` to disable.
   */
  weekly_attribute?: string | null;
}

const DEFAULT_WEEKLY_ATTRIBUTE = "feed_daily_list";

/**
 * Best-effort coercion of a `repeats` field into ISO weekdays (Mon=1..Sun=7).
 * Accepts: array of numbers, comma-separated string, 7-element bool/0-1 mask,
 * or undefined (=> every day). Numbers are treated as ISO weekdays; values
 * outside 1..7 are silently dropped. Returns `undefined` when every-day or
 * unparseable, matching the persisted-weekdays canonical form.
 */
function parseRepeats(value: unknown): readonly Weekday[] | undefined {
  if (value === undefined || value === null) return undefined;

  let nums: number[] | null = null;
  if (Array.isArray(value)) {
    if (
      value.length === 7 &&
      value.every((v) => typeof v === "boolean" || v === 0 || v === 1)
    ) {
      nums = [];
      for (let i = 0; i < 7; i++) {
        if (value[i]) nums.push(i + 1);
      }
    } else {
      nums = value
        .map((v) => {
          if (typeof v === "number") return v;
          if (typeof v === "string") {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : NaN;
          }
          return NaN;
        })
        .filter((n) => Number.isFinite(n));
    }
  } else if (typeof value === "string") {
    nums = value
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  } else if (typeof value === "number") {
    nums = [value];
  }

  if (!nums) return undefined;
  const valid = nums.filter((n) => n >= 1 && n <= 7) as Weekday[];
  if (valid.length === 0) return undefined;
  const unique = [...new Set(valid)].sort((a, b) => a - b);
  if (unique.length === ALL_WEEKDAYS.length) return undefined;
  return unique;
}

/**
 * Coerce a `time` field into {hour, minute}. Accepts:
 * - string "HH:MM" or "H:M"
 * - number 0..1439 → minutes of day
 * - number 0..86399 → seconds of day (used when > 1439)
 * Returns null when unparseable.
 */
function parseTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value === "string") {
    const m = value.match(/^(\d{1,2}):(\d{1,2})/);
    if (m) {
      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      if (
        Number.isFinite(hour) &&
        Number.isFinite(minute) &&
        hour >= 0 &&
        hour < 24 &&
        minute >= 0 &&
        minute < 60
      ) {
        return { hour, minute };
      }
    }
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return parseTime(n);
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    let totalMinutes: number;
    if (value > 1440) {
      totalMinutes = Math.floor(value / 60);
    } else {
      totalMinutes = Math.floor(value);
    }
    if (totalMinutes < 0 || totalMinutes >= 24 * 60) return null;
    return {
      hour: Math.floor(totalMinutes / 60),
      minute: totalMinutes % 60,
    };
  }
  return null;
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  return false;
}

interface ParsedWeeklyEntry {
  key: string;
  hour: number;
  minute: number;
  amount: number;
  weekdays: readonly Weekday[] | undefined;
  suspended: boolean;
  name?: string;
}

/**
 * Parse a feed_daily_list-style attribute into weekly schedule entries.
 * Supports two shapes encountered with Petkit-style integrations:
 * 1. Flat list of entries, each with its own time/amount/repeats.
 * 2. Plans containing an `items` array; the plan-level repeats/suspended
 *    apply to each item unless the item overrides them.
 * Returns null when the attribute is missing or yields zero entries; in
 * that case callers should fall back to the legacy state-regex parser.
 */
function parseFeedDailyList(value: unknown): ParsedWeeklyEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const out: ParsedWeeklyEntry[] = [];
  let autoId = 0;

  const consumeItem = (
    item: Record<string, unknown>,
    parent?: Record<string, unknown>
  ): void => {
    const time = parseTime(
      item.time ?? item.feed_time ?? item.dispense_time ?? item.at
    );
    if (!time) return;
    const rawAmount = item.amount ?? item.portions ?? item.value;
    const amount =
      typeof rawAmount === "number"
        ? rawAmount
        : parseInt(String(rawAmount ?? ""), 10);
    if (!Number.isFinite(amount)) return;

    const weekdays =
      parseRepeats(item.repeats ?? item.days ?? item.weekdays) ??
      (parent ? parseRepeats(parent.repeats ?? parent.days) : undefined);

    const suspended = isTruthyFlag(
      item.suspended ?? parent?.suspended ?? item.disabled ?? parent?.disabled
    );

    const explicitId = item.id ?? item.key ?? item.plan_id;
    const key =
      explicitId !== undefined && explicitId !== null
        ? String(explicitId)
        : `w${autoId}`;
    autoId++;

    const name =
      typeof item.name === "string"
        ? item.name
        : typeof item.label === "string"
          ? item.label
          : typeof parent?.name === "string"
            ? (parent.name as string)
            : undefined;

    out.push({
      key,
      hour: time.hour,
      minute: time.minute,
      amount,
      weekdays,
      suspended,
      name,
    });
  };

  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const items = obj.items ?? obj.feeds ?? obj.entries;
    if (Array.isArray(items) && items.length > 0) {
      for (const child of items) {
        if (child && typeof child === "object") {
          consumeItem(child as Record<string, unknown>, obj);
        }
      }
    } else {
      consumeItem(obj);
    }
  }

  return out.length > 0 ? out : null;
}

function getFirstGap(arr: Array<number>): number {
  arr.sort((a, b) => a - b);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== i) {
      return i;
    }
  }
  return arr.length;
}

function getNextId(arr: Array<number>): number {
  return !arr.length ? 0 : Math.min(getFirstGap(arr), Math.max(...arr) + 1);
}

export default class CustomDevice extends Device<CustomDeviceConfig> {
  readonly statusPattern: RegExp;
  readonly statusMap: Record<string, EntryStatus>;

  constructor(deviceConfig: CustomDeviceConfig, hass: HomeAssistant) {
    super(deviceConfig, hass);

    this.statusPattern = new RegExp(deviceConfig.status_pattern);
    this.statusMap = deviceConfig.status_map.reduce<
      Record<string, EntryStatus>
    >((acc, item) => {
      const [key, value] = item.split(" -> ");
      acc[key] = value as EntryStatus;
      return acc;
    }, {});
  }

  private getWeeklyAttributeName(): string | null {
    const cfg = this.deviceConfig.weekly_attribute;
    if (cfg === null) return null;
    return cfg ?? DEFAULT_WEEKLY_ATTRIBUTE;
  }

  /**
   * Parsed weekly entries, or null when the attribute is absent/empty.
   * Recomputed each call so it stays in sync with hass updates.
   * Returns null when hass is not yet attached (setConfig runs first).
   */
  private getWeeklyEntries(): ParsedWeeklyEntry[] | null {
    const attrName = this.getWeeklyAttributeName();
    if (!attrName) return null;
    if (!this.hass?.states) return null;
    const entity = this.hass.states[this.deviceConfig.entity];
    if (!entity) return null;
    const value = entity.attributes?.[attrName];
    return parseFeedDailyList(value);
  }

  get capabilities(): DeviceCapabilities {
    const actions = this.deviceConfig.actions;
    const weekly = this.getWeeklyEntries();
    const hasWeeklySchedule = weekly !== null;
    if (hasWeeklySchedule) {
      return {
        hasEntryToggle: false,
        hasGlobalToggle: !!this.deviceConfig.switch,
        canAddEntries: false,
        canRemoveEntries: false,
        canEditEntries: false,
        maxEntries: this.deviceConfig.max_entries,
        hasWeeklySchedule: true,
      };
    }
    return {
      hasEntryToggle: !!actions?.toggle,
      hasGlobalToggle: !!this.deviceConfig.switch,
      canAddEntries: !!actions?.add,
      canRemoveEntries: !!actions?.remove,
      canEditEntries: !!actions?.edit,
      maxEntries: this.deviceConfig.max_entries,
      hasWeeklySchedule: false,
    };
  }

  get entryFields(): EntryFieldDescriptor[] {
    const config: AmountConfig = {
      min: this.deviceConfig.min_amount,
      max: this.deviceConfig.max_amount,
      step: this.deviceConfig.step_amount,
    };
    return [{ role: EntryFieldRole.QUANTITY, config }];
  }

  getWatchedEntities(): string[] {
    const entities = [this.deviceConfig.entity];
    if (this.deviceConfig.switch) {
      entities.push(this.deviceConfig.switch);
    }
    return entities;
  }

  getDisplayInfo(): DeviceDisplayInfo {
    const state =
      this.hass.states[this.deviceConfig.switch ?? this.deviceConfig.entity];
    return {
      name: state?.attributes.friendly_name,
      icon: state?.attributes.icon,
    };
  }

  isAvailable(): boolean {
    const entity = this.hass.states[this.deviceConfig.entity];
    return !!entity && entity.state !== "unavailable";
  }

  getSchedule(): ScheduleEntry[] {
    const weekly = this.getWeeklyEntries();
    if (weekly !== null) {
      return weekly
        .map<ScheduleEntry>((entry) => ({
          key: entry.key,
          hour: entry.hour,
          minute: entry.minute,
          values: [entry.amount],
          status: entry.suspended ? EntryStatus.DISABLED : EntryStatus.PENDING,
          weekdays: entry.weekdays,
        }))
        .sort((a, b) => a.hour - b.hour || a.minute - b.minute);
    }

    const state = this.hass.states[this.deviceConfig.entity]?.state;
    if (!state) return [];

    const schedules: ScheduleEntry[] = [];
    let res;
    let i = 0;
    const regex = new RegExp(this.statusPattern, "g");
    while (
      (res = regex.exec(state)) !== null &&
      i < this.deviceConfig.max_entries
    ) {
      schedules.push({
        key: res.groups!.id,
        hour: parseInt(res.groups!.hour),
        minute: parseInt(res.groups!.minute),
        values: [parseInt(res.groups!.amount)],
        status: this.statusMap[parseInt(res.groups!.status)],
      });
      i++;
    }
    return schedules
      .filter(({ hour }) => hour !== 255)
      .sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  }

  getGlobalToggle(): GlobalToggleInfo | null {
    if (!this.deviceConfig.switch) return null;
    const switchEntity = this.hass.states[this.deviceConfig.switch];
    if (!switchEntity) return null;
    return { state: switchEntity.state === "on" };
  }

  getDisplayStatus(entry: ScheduleEntry): EntryStatus {
    const { hour, minute, status } = entry;

    if (status === EntryStatus.PENDING) {
      const today = getTodayWeekday(this.hass.config.time_zone);
      const appliesToday = appliesOnWeekday(entry.weekdays, today);
      if (appliesToday) {
        const scheduledDate = new Date();
        scheduledDate.setHours(hour, minute);
        const isPastDue = new Date().getTime() > scheduledDate.getTime();
        if (isPastDue) {
          return EntryStatus.SKIPPED;
        }
      }

      const globalToggle = this.getGlobalToggle();
      if (globalToggle?.state === false) {
        return EntryStatus.DISABLED;
      }
    }

    return status;
  }

  private callAction(
    actionKey: keyof ServiceCallActionConfig,
    data: Record<string, unknown>
  ): Promise<void> {
    const actionStr = this.deviceConfig.actions?.[actionKey];
    if (!actionStr) return Promise.resolve();
    const [domain, action] = actionStr.split(".");
    return this.hass.callService(domain, action, data);
  }

  private getAmountKey(actionKey: keyof ServiceCallActionConfig): string {
    const actionStr = this.deviceConfig.actions?.[actionKey];
    if (!actionStr) return "amount";
    const [domain, action] = actionStr.split(".");
    try {
      return (
        Object.keys(this.hass.services[domain][action].fields).find((k) =>
          ["amount", "portions"].includes(k)
        ) ?? "amount"
      );
    } catch {
      return "amount";
    }
  }

  async addEntry(entry: EditScheduleEntry): Promise<void> {
    const existingKeys = this.getSchedule().map((e) => parseInt(e.key));
    const id = getNextId(existingKeys);
    const amountKey = this.getAmountKey("add");
    await this.callAction("add", {
      id,
      hour: entry.hour,
      minute: entry.minute,
      [amountKey]: entry.values[0],
    });
  }

  async editEntry(entry: EditScheduleEntry): Promise<void> {
    if (entry.key === null) return;
    const amountKey = this.getAmountKey("edit");
    await this.callAction("edit", {
      id: parseInt(entry.key),
      hour: entry.hour,
      minute: entry.minute,
      [amountKey]: entry.values[0],
    });
  }

  async removeEntry(entry: ScheduleEntry): Promise<void> {
    await this.callAction("remove", { id: parseInt(entry.key) });
  }

  async toggleEntry(entry: ScheduleEntry): Promise<void> {
    await this.callAction("toggle", { id: parseInt(entry.key) });
  }

  async setGlobalToggle(enabled: boolean): Promise<void> {
    if (!this.deviceConfig.switch) return;
    const action = enabled ? "turn_on" : "turn_off";
    await this.hass.callService("homeassistant", action, {
      entity_id: this.deviceConfig.switch,
    });
  }

  getNewEntryDefaults(): EditScheduleEntry {
    return {
      key: null,
      hour: 0,
      minute: 0,
      values: [this.entryFields[0].config.min],
    };
  }
}
