# First sign-in: the welcome tour

What a person sees the first time they sign in, how it differs by role, and how it is kept in step with the console.
It is for the people who will use the platform every day. It is not the demo (see [demo.md](demo.md)), which shows the platform to someone who has not used it.

## What happens

1. After the password and authenticator code, the **welcome card** opens in the middle of the page and the page behind is dimmed. It says what the platform is and what it is not (no remote shell, no file transfer, every change confirmed and logged). The person chooses **Take the tour** (every menu item and every cabinet tab), **Short version** (the menu, and the cabinet tabs that matter on the first day), or **Skip tour**.
2. The tour is a small guide beside the page, not a popup. Each step opens the page it is about, outlines the real menu item or tab, and dims the rest. The guide moves beside the outlined control so it never covers it.
3. If a cabinet exists, the tour opens one (a real one before a simulated one, an online one before an offline one) and goes through each of its tabs. If none exists yet, it says so and offers the tour again from **Account** once there is one.
4. Leaving by any route (Finish, Skip tour, Escape) counts as seen: it is recorded on the person's account and is not shown again at the next sign-in. **Account → Run the tour again** starts it again.

## By role

| | Sees |
|---|---|
| Tier 1 | Fleet, Jump to, Search, Alerts, Incidents, Fleet operations, Issues, every cabinet tab, Account |
| Tier 2 with permission to approve fixes | the same, plus **Fixes** |
| Admin | the same, plus **Fixes** and **Admin** (Set up and demo, users, audit log, software library, upgrades, clients and sites, settings) |

Each cabinet tab's step says what the tab is for and, where it matters, who may do what there ("Anyone may restart, with a code. Shutting down needs an Admin.").

## Keeping it right

- The steps are data in `console/src/lib/welcome-tour.ts`. A unit test (`console/test/welcome-tour.test.ts`) fails if a cabinet tab (`console/src/lib/sections.ts`) has no step, if a menu step does not point at a link the menu has, or if a role is told about a menu it does not have. Add a tab and the test asks for its step.
- A browser test (`server/test/console-welcome-tour-e2e.test.ts`) signs in as an Admin, a Tier 1 and a Tier 2 person and walks the whole tour: each step's control is outlined, each tab's link is the one outlined, the heading takes the keyboard focus, Back works, Escape leaves, a reload resumes in the same place, and it is not shown again once seen.
- Pointing at controls uses the same code as the guided demo (`console/src/lib/spotlight.ts`).
- Accessibility: the guide is a non-modal dialog labelled by the step title; the title takes the focus at each step; every action is a button; nothing depends on colour or on the pointer.
