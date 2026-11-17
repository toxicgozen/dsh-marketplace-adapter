/**
 * Browser half of dsh-marketplace-adapter.
 *
 * It contributes the **Marketplace** row at the left sidebar's global panel list
 * and the page that row opens in the main column. The page reads one JSON
 * snapshot from the Host row's exact Fetch route; adding, removing and syncing
 * stay with the `/marketplace` command, so both halves never reimplement each
 * other.
 *
 * The module is loaded by the Web page's client module table, not bundled: the
 * factory receives `require` from that table and returns this plugin's body.
 */
window.__ModuleLoader__.load({
  id: 'dsh-marketplace-adapter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'marketplace';
    /** The id shared by the sidebar row and the main panel it opens. */
    const PANEL_ID = 'marketplace';
    /** Page-relative form of the Host row's exact Fetch route. */
    const STATUS_PATH = 'api/marketplace-adapter/status';
    /** Prefix for every generated class name, so the page never matches host CSS. */
    const PREFIX = 'dsh-marketplace';

    const zh = {
      panel: 'Marketplace',
      title: 'Marketplace',
      intro: '从打包的 agent marketplace 接入的技能',
      refresh: '刷新',
      refreshing: '刷新中…',
      retry: '重试',
      updated: '读取于 {time}',
      loading: '正在读取 marketplace…',
      emptyTitle: '还没有接入 marketplace',
      empty: '用 /marketplace add <owner/repo> 添加一个；加入后的技能会出现在技能列表里。',
      hint: '添加、移除和同步使用 /marketplace 命令。',
      revision: 'Snapshot',
      lastSync: '最后同步',
      never: '从未',
      notSynced: '尚未同步',
      originConfig: '来自配置',
      originStore: '通过 /marketplace add 添加',
      syncing: '同步中',
      packageCount: '包',
      skillCount: '技能',
      package: '包',
      version: '版本',
      skillsHeader: '技能',
      mirrorMissing: '本地快照尚未就绪；运行 /marketplace sync 下载一次。',
      errorTitle: '无法读取 marketplace',
      errorDetail: '状态接口没有返回可读数据（{reason}）。',
      staleDetail: '下面是上次成功读取的内容。',
      failureLine: '这个 marketplace 有问题：',
    };

    const en = {
      panel: 'Marketplace',
      title: 'Marketplace',
      intro: 'Skills adapted from packaged agent marketplaces',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      retry: 'Retry',
      updated: 'As of {time}',
      loading: 'Reading marketplaces…',
      emptyTitle: 'No marketplace is adapted yet',
      empty: 'Add one with /marketplace add <owner/repo>; its skills appear in the skill list afterwards.',
      hint: 'Add, remove and sync with the /marketplace command.',
      revision: 'Snapshot',
      lastSync: 'Last sync',
      never: 'Never',
      notSynced: 'Not synced yet',
      originConfig: 'From config',
      originStore: 'Added with /marketplace add',
      syncing: 'Syncing',
      packageCount: 'Packages',
      skillCount: 'Skills',
      package: 'Package',
      version: 'Version',
      skillsHeader: 'Skills',
      mirrorMissing: 'The local snapshot is not ready yet; run /marketplace sync once.',
      errorTitle: 'Could not read marketplaces',
      errorDetail: 'The status route returned nothing readable ({reason}).',
      staleDetail: 'Showing the last successful read.',
      failureLine: 'This marketplace reported a problem:',
    };

    /** Locale-aware timestamp; an unparseable value shows nothing. */
    function formatTime(iso) {
      if (iso === null || iso === undefined) return undefined;
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return undefined;
      const language = document.documentElement.lang || undefined;
      try {
        return date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
      } catch {
        return date.toLocaleString();
      }
    }

    /**
     * Read the Host snapshot, keeping the last good one visible while a refresh
     * runs or fails. A slower response never replaces a newer one.
     */
    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', data: null, error: null });
      const read = React.useRef(0);

      const load = React.useCallback(async () => {
        const current = ++read.current;
        setSnapshot((previous) => ({
          status: previous.data === null ? 'loading' : 'refreshing',
          data: previous.data,
          error: null,
        }));

        try {
          const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined;
          const response = await fetch(new URL(STATUS_PATH, document.baseURI), {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            ...(timeout === undefined ? {} : { signal: timeout }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (current !== read.current) return;
          setSnapshot({ status: 'ready', data, error: null });
        } catch (error) {
          if (current !== read.current) return;
          setSnapshot((previous) => ({
            status: previous.data === null ? 'error' : 'stale',
            data: previous.data,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }, []);

      React.useEffect(() => {
        void load();
        return () => {
          read.current += 1;
        };
      }, [load]);

      // A Host sync finishes in the background; follow it until the card settles.
      React.useEffect(() => {
        if (snapshot.data === null) return undefined;
        const marketplaces = Array.isArray(snapshot.data.marketplaces) ? snapshot.data.marketplaces : [];
        if (!marketplaces.some((item) => item.syncing === true)) return undefined;
        const timer = setTimeout(() => { void load(); }, 2_500);
        return () => { clearTimeout(timer); };
      }, [snapshot, load]);

      // Coming back to the page is the natural moment to read a stale snapshot again.
      React.useEffect(() => {
        const refresh = () => {
          if (document.visibilityState === 'visible') void load();
        };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          window.removeEventListener('focus', refresh);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, [load]);

      return { snapshot, load };
    }

    /** 16px shopfront glyph; the sidebar supplies size and selected color. */
    function MarketplaceGlyph({ size }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M2.5 6.5V13h11V6.5' }),
        h('path', { d: 'M1.5 6.5 3 3h10l1.5 3.5z' }),
        h('path', { d: 'M6.5 13v-4h3v4' }),
      );
    }

    /** Circular arrow shown inside the refresh button. */
    function RefreshGlyph() {
      return h(
        'svg',
        {
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
        h('path', { d: 'M13 2.5V5h-2.5' }),
      );
    }

    /** Small bordered notice used for the empty and failure states. */
    function Notice({ tone, title, detail, action }) {
      return h(
        'div',
        { className: `${PREFIX}-notice${tone === 'failure' ? ` ${PREFIX}-notice-failure` : ''}`, role: tone === 'failure' ? 'alert' : 'status' },
        h('p', { className: `${PREFIX}-notice-title` }, title),
        h('p', { className: `${PREFIX}-notice-detail` }, detail),
        action,
      );
    }

    /** One marketplace: identity, sync state, and its packages. */
    function MarketplaceCard({ t, marketplace }) {
      const packages = Array.isArray(marketplace.packages) ? marketplace.packages : [];
      const skills = packages.reduce((total, item) => total + item.skills, 0);
      const pairs = [
        [t('revision'), marketplace.revision === null ? t('notSynced') : marketplace.revision.replace(/^sha256:/, '').slice(0, 12)],
        [t('lastSync'), marketplace.lastSync === null ? t('never') : (formatTime(marketplace.lastSync) ?? t('never'))],
        [t('packageCount'), String(packages.length)],
        [t('skillCount'), String(skills)],
      ];

      return h(
        'section',
        { className: `${PREFIX}-card`, 'aria-label': marketplace.name },
        h(
          'div',
          { className: `${PREFIX}-card-head` },
          h('h2', { className: `${PREFIX}-name` }, marketplace.name),
          h('span', { className: `${PREFIX}-badge` }, marketplace.origin === 'config' ? t('originConfig') : t('originStore')),
          marketplace.syncing === true ? h('span', { className: `${PREFIX}-badge` }, t('syncing')) : null,
        ),
        h('p', { className: `${PREFIX}-repo` }, `${marketplace.repository}@${marketplace.ref}`),
        h(
          'dl',
          { className: `${PREFIX}-meta` },
          pairs.map(([label, value]) =>
            h(
              'div',
              { key: label, className: `${PREFIX}-pair` },
              h('dt', { className: `${PREFIX}-meta-label` }, label),
              h('dd', { className: `${PREFIX}-meta-value` }, value),
            ),
          ),
        ),
        marketplace.lastError === null
          ? null
          : h(
              'p',
              { className: `${PREFIX}-failure-line`, role: 'status' },
              `${t('failureLine')} ${marketplace.lastError}`,
            ),
        marketplace.complete === false && marketplace.lastError === null && marketplace.syncing !== true
          ? h('p', { className: `${PREFIX}-status-line` }, t('mirrorMissing'))
          : null,
        packages.length === 0
          ? null
          : h(
              'table',
              { className: `${PREFIX}-table` },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { scope: 'col' }, t('package')),
                  h('th', { scope: 'col', className: `${PREFIX}-num` }, t('version')),
                  h('th', { scope: 'col', className: `${PREFIX}-num` }, t('skillsHeader')),
                ),
              ),
              h(
                'tbody',
                null,
                packages.map((item) =>
                  h(
                    'tr',
                    { key: item.name },
                    h('td', null, item.name),
                    h('td', { className: `${PREFIX}-num` }, item.version ?? '—'),
                    h('td', { className: `${PREFIX}-num` }, String(item.skills)),
                  ),
                ),
              ),
            ),
      );
    }

    /** Everything under the page header, per read state. */
    function renderBody(t, snapshot, load) {
      const retry = h(
        'button',
        { type: 'button', className: `${PREFIX}-button`, onClick: () => { void load(); } },
        h(RefreshGlyph),
        h('span', null, t('retry')),
      );

      if (snapshot.data === null) {
        if (snapshot.status === 'error') {
          return h(Notice, {
            tone: 'failure',
            title: t('errorTitle'),
            detail: t('errorDetail', { reason: snapshot.error ?? '' }),
            action: retry,
          });
        }
        return h('p', { className: `${PREFIX}-status`, role: 'status' }, t('loading'));
      }

      const marketplaces = Array.isArray(snapshot.data.marketplaces) ? snapshot.data.marketplaces : [];
      const children = [];

      if (snapshot.status === 'stale') {
        children.push(
          h(Notice, {
            key: 'stale',
            tone: 'failure',
            title: t('errorTitle'),
            detail: `${t('errorDetail', { reason: snapshot.error ?? '' })} ${t('staleDetail')}`,
            action: retry,
          }),
        );
      }

      if (marketplaces.length === 0 && snapshot.status !== 'stale') {
        children.push(
          h(Notice, {
            key: 'empty',
            title: t('emptyTitle'),
            detail: t('empty'),
          }),
        );
      } else {
        for (const marketplace of marketplaces) {
          children.push(h(MarketplaceCard, { key: marketplace.name, t, marketplace }));
        }
      }

      return children;
    }

    /** The global main-column page the sidebar row opens. */
    function MarketplacesPanel(props) {
      const t = props.t;
      const { snapshot, load } = useSnapshot();
      const busy = snapshot.status === 'loading' || snapshot.status === 'refreshing';
      const updated = snapshot.data === null ? undefined : formatTime(snapshot.data.updatedAt);

      return h(
        Fragment,
        null,
        h('style', null, STYLES),
        h(
          'div',
          { className: `${PREFIX}-page` },
          h(
            'header',
            { className: `${PREFIX}-head`, 'data-window-drag': '' },
            h(
              'div',
              { className: `${PREFIX}-heading` },
              h('h1', { className: `${PREFIX}-title` }, t('title')),
              h('p', { className: `${PREFIX}-intro` }, t('intro')),
              h('p', { className: `${PREFIX}-hint` }, t('hint')),
            ),
            h(
              'div',
              { className: `${PREFIX}-toolbar` },
              updated === undefined ? null : h('span', { className: `${PREFIX}-updated` }, t('updated', { time: updated })),
              h(
                'button',
                {
                  type: 'button',
                  className: `${PREFIX}-button`,
                  disabled: busy,
                  'aria-busy': busy,
                  onClick: () => { void load(); },
                },
                h(RefreshGlyph),
                h('span', null, snapshot.status === 'refreshing' ? t('refreshing') : t('refresh')),
              ),
            ),
          ),
          h(
            'div',
            { className: `${PREFIX}-body`, 'aria-busy': busy },
            h('div', { className: `${PREFIX}-column` }, renderBody(t, snapshot, load)),
          ),
        ),
      );
    }

    /**
     * Page styles. Component-local so unmounting the panel removes them; only
     * host theme tokens are referenced, and hover affordances sit behind
     * `@media (hover: hover)` so a tap never strands a control in its hover look.
     */
    const STYLES = `
.${PREFIX}-page{display:flex;flex-direction:column;box-sizing:border-box;height:100%;padding:0 clamp(20px,4vw,48px);color:var(--dsw-alias-label-primary)}
@media (max-width:767px){.${PREFIX}-page{padding:0 20px}}
.${PREFIX}-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 24px;box-sizing:border-box;width:100%;max-width:960px;margin:0 auto;padding-top:28px;padding-bottom:20px}
html[data-platform='darwin'] .${PREFIX}-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.${PREFIX}-heading{min-width:0;max-width:100%}
.${PREFIX}-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.${PREFIX}-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.${PREFIX}-hint{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${PREFIX}-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px}
.${PREFIX}-updated{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${PREFIX}-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.${PREFIX}-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.${PREFIX}-button:disabled{opacity:.55;cursor:default}
@media (hover:hover){.${PREFIX}-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.${PREFIX}-body{flex:1;min-height:0;width:100%;margin:0 auto;overflow-y:auto;scrollbar-gutter:stable;padding-bottom:48px}
.${PREFIX}-column{display:flex;flex-direction:column;gap:16px;width:100%;max-width:960px;margin:0 auto}
.${PREFIX}-status{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.${PREFIX}-notice{display:flex;flex-direction:column;align-items:flex-start;gap:8px;box-sizing:border-box;padding:20px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.${PREFIX}-notice-title{margin:0;font-size:14px;line-height:22px;font-weight:500}
.${PREFIX}-notice-failure .${PREFIX}-notice-title{color:var(--dsw-alias-state-error-primary)}
.${PREFIX}-notice-detail{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.${PREFIX}-card{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:16px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.${PREFIX}-card-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.${PREFIX}-name{margin:0;font-size:14px;font-weight:500;line-height:20px}
.${PREFIX}-badge{padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${PREFIX}-repo{margin:0;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.${PREFIX}-meta{display:flex;flex-wrap:wrap;gap:10px 24px;margin:0}
.${PREFIX}-pair{display:flex;flex-direction:column;gap:2px;min-width:0}
.${PREFIX}-meta-label{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${PREFIX}-meta-value{margin:0;font-size:13px;line-height:20px;font-variant-numeric:tabular-nums}
.${PREFIX}-failure-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.${PREFIX}-status-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${PREFIX}-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px;line-height:20px}
.${PREFIX}-table th{padding:0 8px 6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l3);font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:left}
.${PREFIX}-table td{padding:6px 8px 6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l3);overflow-wrap:anywhere}
.${PREFIX}-table tr:last-child td{border-bottom:0}
.${PREFIX}-num{width:88px;text-align:right;font-variant-numeric:tabular-nums}
`;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'marketplace-adapter: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('panel'),
              locale: NS,
            },
            MarketplaceGlyph,
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            MarketplacesPanel,
          ),
        );
      },
    };
  },
});
