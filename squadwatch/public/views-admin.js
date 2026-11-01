'use strict';
/* SquadWatch — views-admin.js (STAGE-1 PLACEHOLDER — a later stage REPLACES this file)
 *
 * Final file registers Admin / Console / Bans / Audit / Users / Settings views
 * (login + setup live in app.js). Conventions (established by app.js):
 *   - SW.routes[name] = { render(el, ctx), cleanup(), role? } — see views.js header.
 *   - Console output, audit rcon_command/rcon_response, unmatched samples and flag
 *     details MUST be rendered via textContent / <pre> nodes only (spec 19.3.25).
 *   - Admin POSTs go through SW.api; show results with SW.ui.rconToast(title, res).
 */
(function () {
  const SW = window.SW;

  function placeholder(title, iconName, role) {
    return {
      role,
      render(el) {
        const card = document.createElement('div');
        card.className = 'card placeholder-card';
        const ic = document.createElement('div');
        ic.className = 'placeholder-icon';
        ic.innerHTML = SW.icon(iconName);
        const h = document.createElement('h2');
        h.textContent = title;
        const p = document.createElement('p');
        p.className = 'dim';
        p.textContent = 'Loading this view soon — it arrives in a later build stage.';
        card.append(ic, h, p);
        el.append(card);
      },
      cleanup() {},
    };
  }

  SW.routes.admin = placeholder('Admin tools', 'gavel', 'admin');
  SW.routes.console = placeholder('RCON console', 'terminal', 'owner');
  SW.routes.bans = placeholder('Bans', 'ban', 'admin');
  SW.routes.audit = placeholder('Audit log', 'scroll', 'admin');
  SW.routes.users = placeholder('Users', 'user-cog', 'owner');
  SW.routes.settings = placeholder('Settings', 'settings', 'owner');
})();
