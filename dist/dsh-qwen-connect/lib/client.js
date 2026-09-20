/**
 * 浏览器侧插件入口：向「设置 → 插件」贡献千问办公状态卡片。
 *
 * 格式要求（与 DSH 0.1.2-rc.1 的 client 模块加载器一致）：
 * 本文件不是 ESM 模块，而是 `window.__ModuleLoader__.load({ id, factory })`
 * 的自执行包装，末尾导出 `apply` / `inject` / `name`。
 *
 * 整段 `apply` 被 try/catch 包裹：DSH 的 slot API 一旦发生破坏性变更，
 * 这里退化为一条 console.error，而**不会**抛进 DSH loader 触发红色
 * "Failed to load plugins" 横幅——host 侧 provider 与状态路由都不受影响。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qwen-connect',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react = require('react');
    let react_jsx_runtime = require('react/jsx-runtime');

    //#region status-paths.ts
    /** 与 lib/status-paths.js 保持一致（client 半无法 import host 模块）。 */
    const QWENWORK_STATUS_PATH = '/plugins/dsh-qwen-connect/status';
    const POLL_INTERVAL_MS = 60000;
    //#endregion

    //#region 样式
    const cardStyle = {
      overflow: 'hidden',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-module-platform)',
    };
    const headerStyle = {
      boxSizing: 'border-box',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      border: 0,
      padding: '13px 14px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    };
    const headTextStyle = {
      display: 'flex',
      minWidth: 0,
      flexDirection: 'column',
      gap: 3,
    };
    const nameStyle = { fontSize: 14, lineHeight: '20px', fontWeight: 600 };
    const descriptionStyle = {
      fontSize: 13,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const chevronStyle = {
      flex: '0 0 auto',
      fontSize: 18,
      lineHeight: 1,
      transition: 'transform 120ms ease',
    };
    const bodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      borderTop: '1px solid var(--dsw-alias-border-l2)',
      padding: '13px 14px',
    };
    const rowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      lineHeight: '18px',
    };
    const labelStyle = { color: 'var(--dsw-alias-label-tertiary)' };
    const valueStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontVariantNumeric: 'tabular-nums',
      textAlign: 'right',
    };
    const errorStyle = {
      fontSize: 13,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'pre-wrap',
    };
    const modelRowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      lineHeight: '18px',
    };
    // ---- WorkBuddy 风格的分组 / 进度条样式 --------------------------------
    const sectionStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      paddingTop: 2,
    };
    const quotaGroupStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    };
    const sectionTitleStyle = {
      margin: 0,
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    };
    const quotaLabelStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const progressTrackStyle = {
      height: 8,
      overflow: 'hidden',
      borderRadius: 999,
      background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))',
    };
    function progressFillStyle(percent) {
      return {
        width: `${Math.max(0, Math.min(100, percent))}%`,
        height: '100%',
        borderRadius: 'inherit',
        background: 'var(--dsw-alias-brand-primary, #1677ff)',
      };
    }
    /** 已登录状态圆点（与 WorkBuddy 卡片一致）。 */
    function dotStyle(status) {
      return {
        width: 9,
        height: 9,
        borderRadius: '50%',
        flex: '0 0 auto',
        background:
          status === 'signed-in'
            ? 'var(--dsw-alias-state-success-primary, #22a06b)'
            : status === 'error'
              ? 'var(--dsw-alias-state-error-primary, #d92d20)'
              : 'var(--dsw-alias-label-dimmed, #9aa0a6)',
      };
    }
    const accountRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    };
    const refreshButtonStyle = {
      flex: '0 0 auto',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      padding: '5px 12px',
      background: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    };
    /** 千分位格式化（积分 / 请求数等）。 */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    }
    function formatPercent(value) {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    }
    //#endregion

    /** 展示用的行。 */
    function Row(props) {
      return react_jsx_runtime.jsxs('div', {
        style: rowStyle,
        children: [
          react_jsx_runtime.jsx('span', { style: labelStyle, children: props.label }),
          react_jsx_runtime.jsx('span', { style: valueStyle, children: props.value }),
        ],
      });
    }

    /**
     * 单条配额：有 `remain` + `size` 时画进度条，否则只显示文本。
     *
     * 进度条语义是「剩余百分比」（与 WorkBuddy 卡片一致）。
     */
    function QuotaBar(props) {
      const item = props.item;
      const t = props.t;
      // 防御：客户端不得假设 host 数据完美——网络中断、版本不一致都可能让
      // 条目变成 null / 非对象。此处返回 null 而非抛异常，避免整个卡片白屏
      // （React 错误未被捕获时，DSH 会显示"加载失败"，用户彻底看不到卡片）。
      if (item === null || typeof item !== 'object') return null;
      const hasBar =
        typeof item.remain === 'number' && typeof item.size === 'number' && item.size > 0;
      const percent = hasBar ? (item.remain / item.size) * 100 : null;
      // `item.size` 可能来自「参考基准」而非上游真实总量——此时右侧文案
      // 不能写「剩余 X%」（会让人误以为那是剩余比例），改为「较峰值 X%」。
      const isBaseline = item.baselineBased === true;

      // 右侧文字：有进度条时显示百分比，否则显示额度本身
      let right;
      if (hasBar) {
        right = isBaseline
          ? t('peakLevel', { percent: formatPercent(percent) })
          : t('percentRemaining', { percent: formatPercent(percent) });
      } else if (item.detail !== undefined) {
        right = item.detail;
      } else if (typeof item.size === 'number') {
        right = t('quotaAmount', { value: formatNumber(item.size), unit: t(item.unit ?? 'count') });
      } else {
        right = '';
      }

      // 左侧主标签
      const label = t(item.key);

      const children = [
        react_jsx_runtime.jsxs(
          'div',
          {
            style: quotaLabelStyle,
            children: [
              react_jsx_runtime.jsx('span', { children: label }),
              react_jsx_runtime.jsx('span', {
                style: { fontVariantNumeric: 'tabular-nums' },
                children: right,
              }),
            ],
          },
          'label',
        ),
      ];

      if (hasBar) {
        children.push(
          react_jsx_runtime.jsx(
            'div',
            {
              style: progressTrackStyle,
              role: 'progressbar',
              'aria-label': label,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(percent),
              children: react_jsx_runtime.jsx('div', { style: progressFillStyle(percent) }),
            },
            'track',
          ),
        );
        // 精确值一行（对齐 WorkBuddy 的 "剩余 500 / 500"）。
        // 基准模式下**不显示**——那不是真实配额，写出来就是编造。
        if (!isBaseline) {
          children.push(
            react_jsx_runtime.jsx(
              'div',
              {
                style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                children: t('exactRemaining', {
                  remain: formatNumber(item.remain),
                  size: formatNumber(item.size),
                }),
              },
              'exact',
            ),
          );
        } else {
          // 基准模式：只把余额本身写清楚（这是真实值），不写分母。
          children.push(
            react_jsx_runtime.jsx(
              'div',
              {
                style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                children: t('creditBalance', { value: formatNumber(item.remain) }),
              },
              'balance',
            ),
          );
        }
      } else if (typeof item.size === 'number') {
        children.push(
          react_jsx_runtime.jsx(
            'div',
            {
              style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
              children: t('quotaLimit', { value: formatNumber(item.size), unit: t(item.unit ?? 'count') }),
            },
            'limit',
          ),
        );
      }

      return react_jsx_runtime.jsx('div', { style: quotaGroupStyle, children }, props.id);
    }

    /** 一个模型条目：名称 + 倍率。 */
    function ModelRow(props) {
      const model = props.model;
      const t = props.t;
      // 同 QuotaBar：数据异常时返回 null，不让整张卡片白屏。
      if (model === null || typeof model !== 'object') return null;
      const badges = [];
      if (model.isDefault === true) badges.push(t('badgeDefault'));
      if (model.isRecommended === true) badges.push(t('badgeRecommended'));
      if (model.isNew === true) badges.push(t('badgeNew'));

      return react_jsx_runtime.jsxs(
        'div',
        {
          style: { display: 'flex', flexDirection: 'column', gap: 2 },
          children: [
            react_jsx_runtime.jsxs(
              'div',
              {
                style: modelRowStyle,
                children: [
                  react_jsx_runtime.jsx('span', {
                    style: { color: 'var(--dsw-alias-label-secondary)' },
                    children: model.name,
                  }),
                  react_jsx_runtime.jsx('span', {
                    style: {
                      ...valueStyle,
                      color: 'var(--dsw-alias-label-tertiary)',
                      fontSize: 12,
                    },
                    children: model.rate === undefined ? '' : `${model.rate}x`,
                  }),
                ],
              },
              'row',
            ),
            badges.length === 0
              ? null
              : react_jsx_runtime.jsx(
                  'div',
                  {
                    style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                    children: badges.map((label) =>
                      react_jsx_runtime.jsx(
                        'span',
                        {
                          style: {
                            padding: '1px 8px',
                            borderRadius: 999,
                            fontSize: 11,
                            lineHeight: '18px',
                            background:
                              'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
                            color: 'var(--dsw-alias-state-success-primary, #22a06b)',
                          },
                          children: label,
                        },
                        label,
                      ),
                    ),
                  },
                  'badges',
                ),
          ],
        },
        `model-${model.id}`,
      );
    }

    /** 把 host 返回的状态文档渲染成卡片的展开区（WorkBuddy 风格）。 */
    function StatusBody(props) {
      const state = props.state;
      const t = props.t;

      if (state === null) {
        return react_jsx_runtime.jsx('div', { style: errorStyle, children: t('loading') });
      }
      if (state.error !== undefined && state.status !== 'signed-in') {
        const err = state.error;
        const text = [err.message, err.recovery].filter(Boolean).join('\n');
        return react_jsx_runtime.jsx('div', { style: errorStyle, children: text });
      }

      const sections = [];

      // ---- 账号 ----
      const accountRows = [];
      accountRows.push(
        react_jsx_runtime.jsxs(
          'div',
          {
            style: accountRowStyle,
            children: [
              react_jsx_runtime.jsx('span', { style: dotStyle('signed-in') }),
              react_jsx_runtime.jsx('span', {
                children: t('signedInAs', { name: state.nickname ?? state.account ?? '—' }),
              }),
            ],
          },
          'who',
        ),
      );
      // 账号区**只保留一行**「已登录：<名字>」。
      //
      // 移除的三行（用户明确要求精简）：
      //   · 登录标识（用户名）—— 与上一行信息重叠
      //   · 套餐（Free）—— 卡片副标题已有
      //   · 下次到期 —— Free 套餐该字段为 null，从不显示
      sections.push(
        react_jsx_runtime.jsxs(
          'div',
          {
            style: sectionStyle,
            children: [
              react_jsx_runtime.jsx('h3', { style: sectionTitleStyle, children: t('accountHeading') }, 'title'),
              ...accountRows,
            ],
          },
          'section-account',
        ),
      );

      // ---- 额度：只保留「积分」一行（带进度条）----
      const quotaChildren = [];
      //
      // 设计取舍：卡片只展示**账号 + 积分**。此前的「会话数 / 存储空间 /
      // 页面额度 / 月度请求 / 月度流量」是套餐权益上限，对日常使用没有参考
      // 价值，反而淹没真正关心的积分余额（用户明确要求精简）。
      //
      // 进度条语义：上游对 Free 套餐**只给 remaining、不给 total**
      // （实测 `quota.total === null`），因此没有真实分母。此时进度条按
      // **额度基准**（`state.creditBaseline`）画剩余比例，并在文案上标明
      // 是「相对基准」而非「总量」——绝不假装那是真实总量。
      const credits = Array.isArray(state.entitlements)
        ? state.entitlements.find((e) => e !== null && typeof e === 'object' && e.key === 'credits')
        : undefined;
      const remaining =
        typeof state.remaining === 'number'
          ? state.remaining
          : typeof credits?.remain === 'number'
            ? credits.remain
            : undefined;

      if (remaining !== undefined) {
        const hasRealTotal = typeof credits?.size === 'number' && credits.size > 0;
        const baseline = hasRealTotal
          ? credits.size
          : typeof state.creditBaseline === 'number' && state.creditBaseline > 0
            ? state.creditBaseline
            : undefined;
        quotaChildren.push(
          react_jsx_runtime.jsx(
            QuotaBar,
            {
              item: {
                key: 'credits',
                label: t('credits'),
                remain: remaining,
                ...(baseline === undefined ? {} : { size: baseline }),
                // 标记分母来源：真实总量 or 参考基准（文案与精确值行随之变化）
                ...(hasRealTotal ? {} : { baselineBased: true }),
                unit: 'credits',
              },
              t,
              id: 'credits-0',
            },
            'credits-0',
          ),
        );
        sections.push(
          react_jsx_runtime.jsx(
            'div',
            { style: sectionStyle, children: quotaChildren },
            'section-quota',
          ),
        );
      }

      // ---- 上游性能（首 token 延迟 / 输出速率）----
      //
      // 数据来自 shim 的实测采样（最近 20 次成功对话的均值）。**没有样本时
      // 整块不渲染**——显示 0 或 "—" 都会让人误以为是实测值。
      //
      // 这张卡片的用途：用户能直观看到「当前上游到底多快」，从而判断是该
      // 换模型（flash 更便宜也常更快）还是上游当前拥堵。
      const perf = state.perf;
      if (perf !== null && typeof perf === 'object') {
        const perfRows = [];
        if (typeof perf.ttftMs === 'number') {
          perfRows.push(
            react_jsx_runtime.jsxs(
              'div',
              {
                style: rowStyle,
                children: [
                  react_jsx_runtime.jsx('span', { style: labelStyle, children: t('ttft') }),
                  react_jsx_runtime.jsx('span', { style: valueStyle, children: t('ms', { value: formatNumber(perf.ttftMs) }) }),
                ],
              },
              'ttft',
            ),
          );
        }
        if (typeof perf.charsPerSec === 'number') {
          perfRows.push(
            react_jsx_runtime.jsxs(
              'div',
              {
                style: rowStyle,
                children: [
                  react_jsx_runtime.jsx('span', { style: labelStyle, children: t('speed') }),
                  react_jsx_runtime.jsx('span', { style: valueStyle, children: t('charsPerSec', { value: formatNumber(perf.charsPerSec) }) }),
                ],
              },
              'speed',
            ),
          );
        }
        if (perfRows.length > 0) {
          perfRows.push(
            react_jsx_runtime.jsx(
              'div',
              {
                style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
                children: t('perfSampleNote', { count: perf.samples ?? 0 }),
              },
              'note',
            ),
          );
          sections.push(
            react_jsx_runtime.jsxs(
              'div',
              {
                style: sectionStyle,
                children: [
                  react_jsx_runtime.jsx('h3', { style: sectionTitleStyle, children: t('perfHeading') }, 'title'),
                  ...perfRows,
                ],
              },
              'section-perf',
            ),
          );
        }
      }

      // ---- 模型 ----
      if (Array.isArray(state.models) && state.models.length > 0) {
        sections.push(
          react_jsx_runtime.jsxs(
            'div',
            {
              style: sectionStyle,
              children: [
                react_jsx_runtime.jsx('h3', { style: sectionTitleStyle, children: t('models') }, 'title'),
                // `model.id` 在构造 key 时被读取，null 项会在此抛异常 → 先过滤。
                ...state.models
                  .filter((model) => model !== null && typeof model === 'object')
                  .map((model, index) =>
                    react_jsx_runtime.jsx(
                      ModelRow,
                      { model, t },
                      `model-${typeof model.id === 'string' && model.id !== '' ? model.id : index}`,
                    ),
                  ),
              ],
            },
            'section-models',
          ),
        );
      }

      return react_jsx_runtime.jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 18 },
        children: sections,
      });
    }

    /** 千问办公状态卡片。 */
    function QwenWorkPluginCard(props) {
      const t = props.t;
      const [open, setOpen] = react.useState(props.initialOpen === true);
      // `initialState` 仅供离屏渲染检查（tools/client-render-check.mjs）注入用；
      // DSH 运行时不会传该属性，行为与 useState(null) 完全一致。
      const [state, setState] = react.useState(props.initialState ?? null);
      const [busy, setBusy] = react.useState(false);
      const [nonce, setNonce] = react.useState(0);

      react.useEffect(() => {
        let cancelled = false;
        let timer = undefined;

        async function load() {
          try {
            const response = await fetch(QWENWORK_STATUS_PATH, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            });
            if (!response.ok) {
              throw new Error(`${t('requestFailed')} (HTTP ${response.status})`);
            }
            const body = await response.json();
            if (!cancelled) setState(body);
          } catch (error) {
            if (!cancelled) {
              setState({
                status: 'unavailable',
                error: {
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            }
          }
        }

        if (open) {
          load();
          timer = setInterval(load, POLL_INTERVAL_MS);
        }
        return () => {
          cancelled = true;
          if (timer !== undefined) clearInterval(timer);
        };
      }, [open, t, nonce]);

      const signedIn = state !== null && state.status === 'signed-in';
      const subtitle = signedIn
        ? state.remaining === undefined
          ? t('signedIn')
          : `${t('signedIn')} · ${t('credits')} ${state.remaining}`
        : t('subtitle');

      return react_jsx_runtime.jsxs('div', {
        style: cardStyle,
        children: [
          react_jsx_runtime.jsxs('button', {
            type: 'button',
            style: headerStyle,
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            children: [
              react_jsx_runtime.jsxs('span', {
                style: headTextStyle,
                children: [
                  react_jsx_runtime.jsx('span', { style: nameStyle, children: t('title') }),
                  react_jsx_runtime.jsx('span', { style: descriptionStyle, children: subtitle }),
                ],
              }),
              react_jsx_runtime.jsx('span', {
                style: { ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' },
                children: '\u2304',
              }),
            ],
          }),
          open
            ? react_jsx_runtime.jsxs('div', {
                style: bodyStyle,
                children: [
                  react_jsx_runtime.jsxs('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 16,
                    },
                    children: [
                      react_jsx_runtime.jsx('div', {
                        style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                        children: signedIn ? t('signedIn') : t('subtitle'),
                      }),
                      react_jsx_runtime.jsx('button', {
                        type: 'button',
                        style: refreshButtonStyle,
                        disabled: busy,
                        onClick: () => {
                          setBusy(true);
                          setNonce((v) => v + 1);
                          setTimeout(() => setBusy(false), 800);
                        },
                        children: busy ? t('refreshing') : t('refresh'),
                      }),
                    ],
                  }),
                  react_jsx_runtime.jsx(StatusBody, { state, t }),
                ],
              })
            : null,
        ],
      });
    }

    //#region 文案
    const zh = {
      title: '千问办公',
      subtitle: '复用千问办公桌面 App 登录态',
      signedIn: '已登录',
      signedInAs: '已登录：{name}',
      loading: '正在读取状态…',
      refresh: '刷新',
      refreshing: '刷新中…',
      accountHeading: '账号',
      quotaHeading: '剩余积分',
      nickname: '账号',
      account: '登录标识',
      plan: '套餐',
      nextDue: '下次到期',
      credits: '积分',
      creditsTotal: '合计：{total}',
      used: '已用',
      models: '可选模型',
      // 上游性能
      perfHeading: '上游速度',
      ttft: '首 token 延迟',
      speed: '输出速率',
      ms: '{value} 毫秒',
      charsPerSec: '{value} 字/秒',
      perfSampleNote: '基于最近 {count} 次对话实测',
      requestFailed: '读取插件状态失败',
      // 配额条目
      sessions: '会话数',
      storage: '存储空间',
      pageQuota: '页面额度',
      monthRequests: '月度请求',
      monthTraffic: '月度流量',
      // 单位
      count: '个',
      GB: 'GB',
      // 配额展示
      percentRemaining: '剩余 {percent}%',
      exactRemaining: '剩余 {remain} / {size}',
      // 上游不给总量时的措辞：表达"相对峰值还剩多少"，不假装那是配额剩余
      peakLevel: '较峰值 {percent}%',
      creditBalance: '当前余额 {value}',
      quotaLimit: '上限 {value} {unit}',
      quotaAmount: '{value} {unit}',
      // 模型徽章
      badgeDefault: '默认',
      badgeRecommended: '推荐',
      badgeNew: '新',
    };
    const en = {
      title: 'QwenWork',
      subtitle: "Reuses the QwenWork desktop app's sign-in",
      signedIn: 'Signed in',
      signedInAs: 'Signed in: {name}',
      loading: 'Reading status…',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      accountHeading: 'Account',
      quotaHeading: 'Remaining credits',
      nickname: 'Account',
      account: 'Identity',
      plan: 'Plan',
      nextDue: 'Next due',
      credits: 'Credits',
      creditsTotal: 'Total: {total}',
      used: 'Used',
      models: 'Available models',
      perfHeading: 'Upstream speed',
      ttft: 'First token',
      speed: 'Output rate',
      ms: '{value} ms',
      charsPerSec: '{value} chars/s',
      perfSampleNote: 'Measured over the last {count} conversations',
      requestFailed: 'Failed to read plugin status',
      sessions: 'Sessions',
      storage: 'Storage',
      pageQuota: 'Page quota',
      monthRequests: 'Monthly requests',
      monthTraffic: 'Monthly traffic',
      count: '',
      GB: 'GB',
      percentRemaining: '{percent}% remaining',
      exactRemaining: '{remain} / {size} remaining',
      peakLevel: 'peak {percent}%',
      creditBalance: 'Current balance {value}',
      quotaLimit: 'Limit {value} {unit}',
      quotaAmount: '{value} {unit}',
      badgeDefault: 'Default',
      badgeRecommended: 'Recommended',
      badgeNew: 'New',
    };
    //#endregion

    const name = 'dsh-qwen-connect';
    const inject = ['slots', 'locale'];

    /**
     * 注册卡片文案与卡片本体。
     *
     * 0.1.2 的 slot 注册用 `key` / `priority`（rc.6→rc.7 曾把 `id`/`order`
     * 改名，此处以本机基线 0.1.2-rc.1 为准）。
     */
    function apply(ctx) {
      try {
        const namespace = 'settings.qwenwork';
        ctx.effect(
          () => ctx.locale.register(namespace, { zh, en }),
          'dsh-qwen-connect: settings copy',
        );
        const t = ctx.locale.bind(namespace);
        ctx.slots.inject('settings.plugin.item', () =>
          ctx.slots.register(
            {
              name: 'settings.plugin.item',
              key: 'qwenwork',
              priority: 30,
              inject: () => ({ t }),
            },
            QwenWorkPluginCard,
          ),
        );
      } catch (error) {
        console.error(
          '[dsh-qwen-connect] client card failed to load (host provider unaffected):',
          error,
        );
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
