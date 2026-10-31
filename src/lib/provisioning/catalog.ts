export type Region = {
  value: string;
  label: string;
};

export const REGIONS: Region[] = [
  { value: "eu-nuremberg", label: "Europe — Nuremberg, Germany" },
];

export const DEFAULT_REGION = REGIONS[0].value;

export type OsImage = {
  value: string;
  label: string;
};

/** Only what every node is sure to have: an OS without its template on the node would fail a paid order. */
export const OS_IMAGES: OsImage[] = [{ value: "ubuntu-22.04", label: "Ubuntu 22.04 LTS" }];

export const DEFAULT_OS = "ubuntu-22.04";

export type StackPreset = {
  value: string;
  label: string;
  description: string;
  /** Locks the OS choice when set; null means the user picks freely from OS_IMAGES. */
  lockedOs: string | null;
  categories: string[];
};

export const STACK_PRESETS: StackPreset[] = [
  {
    value: "plain",
    label: "Plain OS (no preinstalled software)",
    description: "A clean server with just the base OS — install anything you like.",
    lockedOs: null,
    categories: ["VPS", "DEDICATED", "SHARED", "STORAGE"],
  },
];

export function getPresetsForCategory(category: string): StackPreset[] {
  return STACK_PRESETS.filter((p) => p.categories.includes(category));
}

export function getPreset(value: string): StackPreset | undefined {
  return STACK_PRESETS.find((p) => p.value === value);
}

export function getOsImage(value: string): OsImage | undefined {
  return OS_IMAGES.find((o) => o.value === value);
}

export function getRegion(value: string): Region | undefined {
  return REGIONS.find((r) => r.value === value);
}

/** Server hostnames and bucket names: 3-63 lowercase letters, digits and hyphens, not starting or ending with a hyphen. */
export const HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Hostnames are case-insensitive and bucket names must be lowercase, so normalise instead of rejecting. */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase();
}

/** Why a (normalised) hostname is invalid, or null when it's fine. */
export function hostnameError(value: string, kind = "Hostname"): string | null {
  if (!value) return `${kind} is required.`;
  if (value.length < 3 || value.length > 63) return `${kind} must be 3-63 characters long.`;
  if (/[^a-z0-9-]/.test(value)) return `Use only letters, numbers and hyphens.`;
  if (!HOSTNAME_PATTERN.test(value)) return `${kind} can't start or end with a hyphen.`;
  return null;
}
