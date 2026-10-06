import { h, card, facts, chip, dateTime, roleLabel, toast } from "./ui.js";

function choice({ name, value, current, title, description, disabled, onSelect }) {
  const id = `${name}-${value}`;
  const input = h("input", { type: "radio", id, name, value, checked: current === value, disabled });
  input.addEventListener("change", () => input.checked && onSelect(value));
  return h("label", { class: `choice ${current === value ? "selected" : ""} ${disabled ? "disabled" : ""}`, for: id },
    input, h("span", null, h("strong", null, title), h("small", null, description)));
}

export async function settingsView({ ctx }) {
  const s = ctx.session;
  const mode = s.mode ?? "live";

  const dataSource = card("Data source", [
    h("p", { class: "muted" }, "Choose what the Console shows. You can switch at any time; your sign-in stays the same."),
    h("div", { class: "choices", role: "radiogroup", "aria-label": "Data source" },
      choice({
        name: "mode", value: "live", current: mode, title: "Live",
        description: "Real cabinets and agents connected to the support server. Diagnostics run on the actual machine.",
        onSelect: v => ctx.setMode(v).catch(err => toast(err.title ?? "Could not switch.", "error")),
      }),
      choice({
        name: "mode", value: "demo", current: mode, title: "Demo",
        description: s.demoAvailable
          ? "A sample fleet for training and sales demos, shown alongside your real cabinets (marked LIVE). Changes to sample items are never saved; actions on LIVE cabinets are real."
          : "Disabled on this Console by its administrator.",
        disabled: !s.demoAvailable,
        onSelect: v => ctx.setMode(v).catch(err => toast(err.title ?? "Could not switch.", "error")),
      })),
  ]);

  const themeChoice = document.documentElement.dataset.themeChoice ?? "dark";
  const appearance = card("Appearance", h("div", { class: "choices three", role: "radiogroup", "aria-label": "Theme" },
    ["dark", "light", "system"].map(value => choice({
      name: "theme", value, current: themeChoice,
      title: { dark: "Dark", light: "Light", system: "Match system" }[value],
      description: { dark: "Easier on the eyes in a dim support room.", light: "High readability in bright rooms.", system: "Follow your computer's setting." }[value],
      onSelect: v => { ctx.applyTheme(v); ctx.rerender(); },
    }))));

  const tour = card("Getting started", [
    h("p", { class: "muted" }, "A one-minute guided tour of the Console: where things are, how diagnostics work" + (ctx.isAdmin ? ", and how to onboard a new cabinet." : ".")),
    h("button", { class: "btn primary", onclick: () => ctx.startTour() }, "Take the tour"),
  ]);

  const account = card("Account", [
    facts([
      ["Name", s.user.displayName], ["Username", s.user.username], ["Role", roleLabel(s.user.role)],
      ["Session ends by", dateTime(s.expiresAt)],
    ]),
    h("a", { class: "btn", href: "#/account" }, "Change password"),
  ]);

  const agent = ctx.isAdmin ? card("Connect a real cabinet", [
    h("p", { class: "muted" }, "Install the Windows Agent on a cabinet PC (or a lab laptop). It registers itself and waits under Administration → Enrollment until you approve it."),
    s.agentServerUrl
      ? facts([["Server address for agents", h("code", null, s.agentServerUrl)], ["Agent key", "The value of AGENT_KEY in the live secrets file on the server host. Never share it in chat or email."]])
      : h("p", { class: "notice" }, "The agent server address is not configured on this Console (CONSOLE_AGENT_SERVER_URL)."),
    h("p", null, "Full steps: ", h("code", null, "docs/live-agent-setup.md"), " in the repository."),
    mode === "demo" ? h("p", null, chip("Demo mode", "warn"), " Agents you install also appear here, marked ● LIVE.") : null,
  ]) : null;

  return h("div", { class: "page narrow-wide" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Preferences"), h("h1", null, "Settings"))),
    dataSource, tour, appearance, account, agent);
}
