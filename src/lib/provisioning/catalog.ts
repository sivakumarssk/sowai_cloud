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

export const OS_IMAGES: OsImage[] = [
  { value: "ubuntu-22.04", label: "Ubuntu 22.04 LTS (Recommended)" },
  { value: "ubuntu-24.04", label: "Ubuntu 24.04 LTS" },
  { value: "debian-12", label: "Debian 12" },
  { value: "almalinux-9", label: "AlmaLinux 9" },
  { value: "rocky-9", label: "Rocky Linux 9" },
];

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
  {
    value: "wordpress",
    label: "WordPress (LEMP stack)",
    description: "Nginx + MySQL + PHP + WordPress, pre-installed and ready to configure.",
    lockedOs: "ubuntu-22.04",
    categories: ["WORDPRESS"],
  },
  {
    value: "nodejs",
    label: "Node.js Runtime",
    description: "Node.js LTS + PM2 + Nginx reverse proxy, ready for your app.",
    lockedOs: "ubuntu-22.04",
    categories: ["VPS", "DEDICATED"],
  },
  {
    value: "python",
    label: "Python Runtime",
    description: "Python 3 + pip + Gunicorn + Nginx reverse proxy.",
    lockedOs: "ubuntu-22.04",
    categories: ["VPS", "DEDICATED"],
  },
  {
    value: "ai-automation",
    label: "AI & Automation (Ollama, n8n, Flowise)",
    description: "Ollama, Open WebUI, n8n, and Flowise pre-installed via Docker.",
    lockedOs: "ubuntu-22.04",
    categories: ["VPS", "DEDICATED"],
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
