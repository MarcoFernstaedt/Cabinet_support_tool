export function createEventInspector(doc, initialEvents = []) {
  const list = doc.querySelector("#event-list");
  const search = doc.querySelector("#event-search");
  const level = doc.querySelector("#level-filter");
  const detail = doc.querySelector("#selected-event");
  const empty = doc.querySelector("#empty-selection");
  const status = doc.querySelector("#result-status");
  const channelNav = doc.querySelector("#channel-nav");
  const activeFilters = doc.querySelector("#active-filters");
  const providerButton = doc.querySelector("#show-provider-events");
  let events = [...initialEvents];
  let selectedId = null;
  let cabinetId = "CAB-01";
  let channelFilter = null;
  let providerFilter = null;

  function renderNavigation() {
    const scoped = events.filter((event) => event.cabinet === cabinetId);
    const counts = new Map();
    for (const event of scoped)
      counts.set(event.channel, (counts.get(event.channel) ?? 0) + 1);
    channelNav.replaceChildren();
    for (const [channel, count] of [[null, scoped.length], ...[...counts].sort(([a], [b]) => String(a).localeCompare(String(b)))]) {
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.channel = channel === null ? "all" : channel;
      button.setAttribute("aria-pressed", String(channel === channelFilter));
      button.append(doc.createTextNode(channel === null ? "All channels" : channel));
      const quantity = doc.createElement("small");
      quantity.textContent = String(count);
      button.append(quantity);
      button.addEventListener("click", () => {
        channelFilter = channel;
        render();
        channelNav.querySelectorAll("button").forEach(item =>
          item.setAttribute("aria-pressed", String(item === button)));
      });
      channelNav.append(button);
    }
  }
  function renderProviderFilter() {
    activeFilters.replaceChildren();
    if (!providerFilter) return;
    const label = doc.createElement("span");
    label.textContent = `Provider: ${providerFilter}`;
    const clear = doc.createElement("button");
    clear.type = "button";
    clear.id = "clear-provider-filter";
    clear.textContent = "Clear provider";
    clear.addEventListener("click", () => { providerFilter = null; render(); search.focus(); });
    activeFilters.append(label, clear);
  }

  function visible() {
    const query = search.value.trim().toLocaleLowerCase();
    return events.filter(
      (event) =>
        event.cabinet === cabinetId &&
        (channelFilter === null || event.channel === channelFilter) &&
        (providerFilter === null || event.provider === providerFilter) &&
        (level.value === "all" || event.level === level.value) &&
        (!query ||
          [
            event.channel,
            event.provider,
            event.level,
            event.eventId,
            event.message,
          ].some((value) =>
            String(value ?? "")
              .toLocaleLowerCase()
              .includes(query),
          )),
    );
  }
  function showSelection(event) {
    selectedId = event?.id ?? null;
    detail.hidden = !event;
    empty.hidden = !!event;
    providerButton.disabled = !event?.provider;
    if (!event) return;
    const fields = {
      "selected-title": `${event.provider} · ${event.eventId}`,
      "selected-level": event.level,
      "selected-channel": event.channel,
      "selected-provider": event.provider,
      "selected-id": String(event.eventId),
      "selected-time": new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(event.occurredAt)),
      "selected-message": event.message || "No message was collected.",
    };
    for (const [id, text] of Object.entries(fields))
      doc.getElementById(id).textContent = text;
    doc.getElementById("selected-level").dataset.level = event.level;
  }
  function render() {
    const filtered = visible();
    if (!filtered.some((event) => event.id === selectedId)) showSelection(null);
    renderProviderFilter();
    list.replaceChildren();
    for (const event of filtered) {
      const row = doc.createElement("button");
      row.type = "button";
      row.className = "event-row";
      row.setAttribute("role", "option");
      row.dataset.eventId = event.id;
      row.setAttribute("aria-selected", String(event.id === selectedId));
      const meta = doc.createElement("span");
      meta.className = "event-meta";
      const badge = doc.createElement("span");
      badge.className = "event-level";
      badge.dataset.level = event.level;
      badge.textContent = event.level;
      const title = doc.createElement("strong");
      title.textContent = `${event.provider} · ${event.eventId}`;
      const channel = doc.createElement("small");
      channel.textContent = event.channel;
      meta.append(badge, title, channel);
      const time = doc.createElement("time");
      time.dateTime = event.occurredAt;
      time.textContent = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(event.occurredAt));
      row.append(meta, time);
      row.addEventListener("click", () => {
        showSelection(event);
        render();
        [...list.querySelectorAll("[data-event-id]")]
          .find((item) => item.dataset.eventId === event.id)
          ?.focus();
      });
      list.append(row);
    }
    status.textContent = filtered.length
      ? `${filtered.length} collected ${filtered.length === 1 ? "event" : "events"}`
      : "No events match this cabinet and filter";
  }
  search.addEventListener("input", render);
  level.addEventListener("change", render);
  providerButton.addEventListener("click", () => {
    const event = events.find(item => item.cabinet === cabinetId && item.id === selectedId);
    if (!event?.provider) return;
    providerFilter = event.provider;
    render();
  });
  list.addEventListener("keydown", (evt) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(evt.key)) return;
    evt.preventDefault();
    const rows = [...list.querySelectorAll("[data-event-id]")];
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.dataset.eventId === selectedId);
    const next =
      evt.key === "Home"
        ? 0
        : evt.key === "End"
          ? rows.length - 1
          : evt.key === "ArrowDown"
            ? Math.min(index + 1, rows.length - 1)
            : Math.max(index - 1, 0);
    rows[next].click();
  });
  doc.querySelector("#copy-message").addEventListener("click", async () => {
    try {
      await doc.defaultView.navigator.clipboard.writeText(
        doc.querySelector("#selected-message").textContent,
      );
      doc.querySelector("#copy-status").textContent = "Message copied.";
    } catch {
      doc.querySelector("#copy-status").textContent =
        "Copy unavailable. Select the message text to copy it.";
    }
  });
  renderNavigation();
  render();
  return {
    setCabinet(id, newEvents) {
      cabinetId = id;
      events = [...newEvents];
      channelFilter = null;
      providerFilter = null;
      search.value = "";
      level.value = "all";
      showSelection(null);
      renderNavigation();
      render();
    },
  };
}
