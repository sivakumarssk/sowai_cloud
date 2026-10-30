// A simulated host for the firewall step. It runs the real generated script line by
// line and answers the way the real tools do:
//   - ufw (src/backend.py, _get_default_policy): routed shows "disabled" whenever the
//     kernel isn't forwarding, whatever the policy; a fresh install's routed policy is deny
//   - sshd -T (OpenSSH 9.2): prohibit-password prints as "without-password"
//   - ufw allow on an existing rule succeeds with "Skipping adding existing rule"

type Policy = "allow" | "deny";

export type FakeFirewall = {
  active: boolean;
  policy: { incoming: Policy; outgoing: Policy; routed: Policy };
  rules: string[];
  ipForward: 0 | 1;
  logging: "on (low)" | "off";
  /** Drop-in written to sshd_config.d. Null = Debian's defaults apply. */
  sshDropIn: string | null;
  /** State at the moment ufw was enabled, to prove the order. */
  atEnable: { policy: FakeFirewall["policy"]; ipForward: number; rules: number } | null;
};

export const freshFirewall = (): FakeFirewall => ({
  active: false,
  policy: { incoming: "deny", outgoing: "allow", routed: "deny" },
  rules: [],
  ipForward: 0,
  logging: "on (low)",
  sshDropIn: null,
  atEnable: null,
});

const pad = (a: string, b: string, c: string) => `${a.padEnd(27)}${b.padEnd(12)}${c}`.trimEnd();

function ruleRow(cmd: string): string[] {
  const port = /^ufw allow (\d+)\/tcp$/.exec(cmd);
  if (port) return [pad(`${port[1]}/tcp`, "ALLOW IN", "Anywhere")];
  const from = /^ufw allow from '?([\d.]+)'? to any port (\d+) proto tcp(?: comment '(.*)')?$/.exec(cmd);
  if (from) return [pad(`${from[2]}/tcp`, "ALLOW IN", from[1] + (from[3] ? `                # ${from[3]}` : ""))];
  const route = /^ufw route allow (in|out) on (\S+)$/.exec(cmd);
  if (route) return [route[1] === "in" ? pad("Anywhere", "ALLOW FWD", `Anywhere on ${route[2]}`) : pad(`Anywhere on ${route[2]}`, "ALLOW FWD", "Anywhere")];
  throw new Error(`fake ufw doesn't know: ${cmd}`);
}

function status(fw: FakeFirewall): string {
  if (!fw.active) return "Status: inactive";
  const routed = fw.ipForward === 1 ? fw.policy.routed : "disabled";
  return [
    "Status: active",
    `Logging: ${fw.logging}`,
    `Default: ${fw.policy.incoming} (incoming), ${fw.policy.outgoing} (outgoing), ${routed} (routed)`,
    "New profiles: skip",
    "",
    pad("To", "Action", "From"),
    pad("--", "------", "----"),
    ...fw.rules,
    "",
  ].join("\n");
}

const sshdSetting = (fw: FakeFirewall, key: string, debianDefault: string) => new RegExp(`^${key} (\\S+)`, "im").exec(fw.sshDropIn ?? "")?.[1]?.toLowerCase() ?? debianDefault;

/** Runs a generated script against the host and returns what it printed. */
export function runFirewallScript(fw: FakeFirewall, script: string): string {
  const out: string[] = [];
  const lines = script.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const heredoc = /^cat > (\S+) <<'?EOF'?$/.exec(line);
    if (heredoc) {
      const body: string[] = [];
      while (lines[++i].trim() !== "EOF") body.push(lines[i]);
      if (heredoc[1].includes("sshd_config.d")) fw.sshDropIn = body.join("\n");
    } else if (line === "ufw --force reset >/dev/null") {
      Object.assign(fw, { active: false, rules: [] });
    } else if (line.startsWith("ufw default ")) {
      const [, , value, direction] = line.split(" ");
      fw.policy[direction as keyof FakeFirewall["policy"]] = value as Policy;
    } else if (line === "ufw logging off") {
      fw.logging = "off";
    } else if (line === "ufw --force enable") {
      fw.active = true;
      fw.atEnable = { policy: { ...fw.policy }, ipForward: fw.ipForward, rules: fw.rules.length };
    } else if (line === "sysctl -q -w net.ipv4.ip_forward=1") {
      fw.ipForward = 1;
    } else if (/^ufw (allow|route) /.test(line)) {
      for (const row of ruleRow(line)) if (!fw.rules.includes(row)) fw.rules.push(row);
    } else if (line.includes("ufw status verbose")) {
      out.push("ufw<<", status(fw), ">>ufw");
    } else if (line.startsWith('echo "sshd_password=')) {
      out.push(`sshd_password=${sshdSetting(fw, "PasswordAuthentication", "yes")}`);
    } else if (line.startsWith('echo "sshd_root=')) {
      const root = sshdSetting(fw, "PermitRootLogin", "prohibit-password");
      out.push(`sshd_root=${root === "prohibit-password" ? "without-password" : root}`);
    } else if (line.startsWith('echo "sshd_kbd=')) {
      out.push(`sshd_kbd=${sshdSetting(fw, "KbdInteractiveAuthentication", "no")}`);
    } else if (line.startsWith('echo "fail2ban=')) {
      out.push("fail2ban=active");
    } else if (line.startsWith('echo "ip_forward=')) {
      out.push(`ip_forward=${fw.ipForward}`);
    }
  }
  return out.join("\n");
}
