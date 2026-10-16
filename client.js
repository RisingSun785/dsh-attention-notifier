window.__ModuleLoader__.load({
  id: 'dsh-attention-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/api/attention-notifier'
    const MARK = '\u25cf '

    /** Copy for both locales; the plugin's own strings are not part of the shell locale. */
    const TEXT = {
      zh: {
        title: '注意力提醒',
        subtitle: 'DSH 需要你操作或任务结束时提醒你。',
        summary: '权限确认、提问、任务完成与出错时，用系统通知 / 提示音 / 应用内提示条提醒你。',
        triggers: '提醒时机',
        approval: '权限确认等待中',
        question: '提问等待中（含计划评审）',
        done: '任务完成',
        error: '任务出错',
        policyOff: '关闭',
        policyUnfocused: '仅窗口不在前台',
        policyAlways: '始终提醒',
        window: '窗口与渠道',
        toast: 'Windows 系统通知',
        sound: '提示音',
        inApp: '应用内提示条',
        minDuration: '任务完成的最短运行时长（秒）',
        minDurationHint: '只对运行时间超过该值的任务发送“任务完成”提醒。',
        rawFallback: '使用“提醒”类通知',
        rawFallbackHint: '当普通通知被系统忽略时，改用可保留在操作中心的提醒通知。',
        test: '测试',
        testToast: '测试系统通知',
        testRaw: '测试提醒通知',
        testSound: '测试提示音',
        testFocus: '测试恢复窗口',
        retry: '重试',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        loadFailed: '无法读取设置（Host 未响应）。',
        status: '状态',
        statusHost: 'Host',
        statusFocus: '窗口焦点上报',
        statusObserved: '已观测（状态变化 / 权限 / 提问 / 轮次结束 / 已提醒 / 已抑制）:',
        statusObservedShort: '已观测',
        statusClient: '页面接触次数（大于 0 即证明本页面加载了插件的客户端半边）:',
        statusProbe: '本页面访问插件路由的结果:',
        probePending: '尚未上报',
        statusResult: '最近的投递结果',
        reported: '已上报',
        unreported: '未上报（按不可见处理）',
        visible: '窗口在前台',
        hidden: '窗口不在前台',
        open: '打开 DSH',
        dismiss: '知道了',
        unsupported: '当前平台不支持系统通知与提示音。',
        approvalNote: '注意：只有审批策略为 ask 的会话才会产生权限确认提醒；策略为 never 时会话会直接拒绝，不会通知。',
      },
      en: {
        title: 'Attention Notifier',
        subtitle: 'Tells you when DeepSeek Harness waits for you or finishes a task.',
        summary: 'System notification, sound, and an in-app notice for approvals, questions, completion, and failures.',
        triggers: 'When to notify',
        approval: 'Waiting for an approval',
        question: 'Waiting for an answer (incl. plan review)',
        done: 'Task finished',
        error: 'Task failed',
        policyOff: 'Off',
        policyUnfocused: 'Only when unfocused',
        policyAlways: 'Always',
        window: 'Window and channels',
        toast: 'Windows notification',
        sound: 'Sound',
        inApp: 'In-app notice',
        minDuration: 'Minimum run time for "finished" (seconds)',
        minDurationHint: 'Only tasks running longer than this report as finished.',
        rawFallback: 'Use reminder-class notifications',
        rawFallbackHint: 'Keeps the notification in the Action Center when normal toasts are suppressed.',
        test: 'Test',
        testToast: 'Test notification',
        testRaw: 'Test reminder',
        testSound: 'Test sound',
        testFocus: 'Test focus window',
        retry: 'Retry',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        loadFailed: 'Could not read settings (the Host did not answer).',
        status: 'Status',
        statusHost: 'Host',
        statusFocus: 'Focus reported by page',
        statusObserved: 'Observed (status / approval / question / turn end / delivered / suppressed):',
        statusObservedShort: 'Observed',
        statusClient: 'Page contacts (above zero proves this page loaded the client half):',
        statusProbe: "This page's request to the plugin route:",
        probePending: 'not reported yet',
        statusResult: 'Last delivery result',
        reported: 'reported',
        unreported: 'never reported (treated as unfocused)',
        visible: 'focused',
        hidden: 'unfocused',
        open: 'Open DSH',
        dismiss: 'Dismiss',
        unsupported: 'This platform has no system notification or sound support.',
        approvalNote: 'Note: approval prompts only exist in sessions whose approval policy is "ask"; a "never" session rejects automatically and never notifies.',
      },
    }

    /** Timestamp of the last user input, used as the idle heuristic. */
    let lastInputAt = Date.now()

    /** Freshness of the last awaited answer, keyed by trigger kind. */
    const lastAlert = new Map()

    if (typeof window !== 'undefined') {
      for (const type of ['pointerdown', 'keydown', 'wheel', 'pointermove']) {
        window.addEventListener(type, () => {
          lastInputAt = Date.now()
        }, { passive: true })
      }
    }

    /**
     * Whether the user is away from the window.
     *
     * `document.hasFocus()` is false whenever another application holds focus,
     * which covers the common "window is minimized or behind something else"
     * case. A long stretch without user input is treated as away too, so a
     * minimized window that still holds focus does not go unreported.
     * @returns True when an "unfocused" alert should be raised.
     */
    function isAway() {
      try {
        if (document.visibilityState === 'hidden') return true
        if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true
        return Date.now() - lastInputAt > 90000
      } catch {
        return true
      }
    }

    /**
     * The raw signals behind {@link isAway}, for the Host's diagnostics.
     *
     * A minimized Electron window on Windows is not reliably reported as hidden,
     * so which of these actually changes is the thing worth observing rather than
     * assuming. Example: `hidden/-focus/away`.
     * @returns Visibility, focus, and the derived verdict as one readable string.
     */
    function awaySignals() {
      try {
        const visibility = document.visibilityState === 'hidden' ? 'hidden' : 'visible'
        const focus = typeof document.hasFocus === 'function'
          ? (document.hasFocus() ? 'focused' : 'unfocused')
          : 'focus-unknown'
        return `${visibility}/${focus}/${isAway() ? 'away' : 'present'}`
      } catch {
        return 'unreadable'
      }
    }

    /**
     * Raise an alert once per distinct request.
     * @param kind - Trigger kind (`approval` or `question`).
     * @param key - Identity of the cause, so one request notifies once.
     * @param title - Banner title.
     * @param body - Banner body.
     */
    function alertUser(kind, key, title, body) {
      const now = Date.now()
      const previous = lastAlert.get(key)
      if (previous !== undefined && now - previous < 5000) return
      lastAlert.set(key, now)
      if (lastAlert.size > 200) lastAlert.clear()
      try {
        window.dispatchEvent(new CustomEvent('dsh-attention', { detail: { kind, title, body, at: now } }))
      } catch {
        // A runtime without CustomEvent simply gets no banner.
      }
      // The alert only exists because the user is away; telling the Host keeps
      // the "unfocused" policy accurate even when no poll has run yet.
      void push('state?visible=0', undefined)
    }

    // ---- Banner ---------------------------------------------------------------

    /**
     * Frame-wide notice for the newest alert.
     * @returns The notice element, or null while nothing is pending.
     */
    function AttentionNotice() {
      const [alert, setAlert] = React.useState(null)
      React.useEffect(() => {
        const onAlert = (event) => setAlert(event.detail)
        window.addEventListener('dsh-attention', onAlert)
        return () => window.removeEventListener('dsh-attention', onAlert)
      }, [])
      React.useEffect(() => {
        if (alert === null) return undefined
        const timer = setTimeout(() => setAlert(null), 120000)
        return () => clearTimeout(timer)
      }, [alert])
      if (alert === null) return null
      const severity = alert.kind === 'done' ? 'done' : alert.kind === 'error' ? 'error' : 'warn'
      const dotColor = severity === 'done'
        ? 'var(--dsw-alias-state-success-primary)'
        : severity === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-warn-primary)'
      return h('div', {
        className: 'dsh-attention-notice',
        'data-dsh-attention-notice': alert.kind,
        style: {
          position: 'absolute',
          top: 28,
          right: 20,
          zIndex: 40,
          maxWidth: 380,
          pointerEvents: 'auto',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '12px 14px',
          borderRadius: 'var(--dsw-radius-xl, 12px)',
          background: 'var(--dsw-alias-bg-overlay)',
          border: '1px solid var(--dsw-alias-border-l2)',
          boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.18))',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { 'aria-hidden': true, className: 'dsh-attention-badge', style: { background: dotColor } }),
          h('span', { style: { fontSize: 14, fontWeight: 500, lineHeight: '20px' } }, alert.title),
        ),
        h('div', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' } }, alert.body),
        // No "open DSH" action here on purpose. This notice is only visible when
        // the window is already in front, so a button that raises the window would
        // be a no-op; the usable route back from a minimized window is the action
        // button carried by the system notification. What this notice adds is the
        // pending item's text, which the toast truncates.
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 } },
          h('button', {
            type: 'button',
            onClick: () => setAlert(null),
            style: { ...plainButtonStyle, background: 'var(--dsw-alias-brand-primary)', color: '#fff', borderColor: 'transparent' },
          }, '知道了'),
        ),
      )
    }

    const plainButtonStyle = {
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      padding: '4px 12px',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
    }

    // ---- Settings page --------------------------------------------------------

    /** Read the whole state snapshot, including pending notices and the cursor. */
    let cursor = 0

    /** Why the most recent route call failed, or null when it succeeded. */
    let lastPushFailure = null

    /**
     * Call one route action.
     *
     * @param action - Path segment.
     * @param body - JSON body for POST, or undefined for GET.
     * @returns Parsed response, or undefined on any failure. The failure is also
     *   exposed through {@link lastPushFailure}, because a `undefined` return
     *   alone cannot distinguish a rejected request from a non-OK status, and that
     *   difference decides whether the problem is the transport or this plugin.
     */
    async function push(action, body) {
      try {
        const response = body === undefined
          ? await fetch(`${ROUTE}/${action}`, { credentials: 'same-origin' })
          : await fetch(`${ROUTE}/${action}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        if (!response.ok) {
          // Read the body: the gateway's rejection text differs from this plugin's
          // own JSON error, which is what identifies the responder.
          let detail = ''
          try {
            detail = (await response.text()).slice(0, 160)
          } catch {
            // A body that cannot be read still leaves the status.
          }
          lastPushFailure = `${action} -> HTTP ${String(response.status)} ${detail}`
          return undefined
        }
        lastPushFailure = null
        return await response.json()
      } catch (error) {
        lastPushFailure = `${action} -> ${String(error?.message ?? error)}`
        return undefined
      }
    }

    /**
     * One labelled checkbox row.
     * @param props - Label, checked value, and change handler.
     * @returns Row element.
     */
    function Check(props) {
      return h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: '22px', cursor: 'pointer' },
      },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, props.label),
      )
    }

    /**
     * One select row.
     * @param props - Label, value, options, and change handler.
     * @returns Row element.
     */
    function SelectRow(props) {
      return h('label', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14, lineHeight: '22px' },
      },
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, props.label),
        h('select', {
          value: props.value,
          onChange: (event) => props.onChange(event.target.value),
          style: {
            font: 'inherit',
            fontSize: 13,
            padding: '4px 8px',
            borderRadius: 'var(--dsw-radius-md, 8px)',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
          },
        }, props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
      )
    }

    /**
     * Format the Host's record of the page's own route probe.
     *
     * This is the diagnostic for the one thing the Host cannot observe directly:
     * whether the Electron window, which is served over `dsh-app://`, can reach
     * this plugin's route the same way a browser tab can.
     * @param clientProbe - Probe record from the Host, or undefined.
     * @returns Human-readable outcome.
     */
    function formatProbe(clientProbe, copy) {
      if (clientProbe === undefined || clientProbe === null || clientProbe.at === 0) return copy.probePending
      if (clientProbe.ok === true) return `OK ${String(clientProbe.status ?? '')} ${String(clientProbe.body ?? '').slice(0, 80)}`
      const parts = [
        clientProbe.status === null ? 'no status' : `HTTP ${String(clientProbe.status)}`,
        clientProbe.error ?? '',
        String(clientProbe.body ?? '').slice(0, 80),
      ].filter((part) => String(part).length > 0)
      return parts.join(' · ')
    }

    /**
     * Format the Host's observation counters.
     *
     * These make the plugin's wiring auditable from the page: a non-zero status
     * count proves the plugin is subscribed to the agent's state machine, and a
     * growing suppressed count explains why nothing was raised.
     * @param observed - Counter record from the Host, or undefined.
     * @returns Compact one-line summary.
     */
    function formatObserved(observed) {
      if (observed === undefined || observed === null) return '—'
      return [
        observed.status ?? 0,
        observed.approval ?? 0,
        observed.question ?? 0,
        observed.turnEnd ?? 0,
        observed.delivered ?? 0,
        observed.suppressed ?? 0,
      ].join(' / ')
    }

    /** Section wrapper with a heading. */
    function Section(props) {
      return h('section', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '14px 16px',
          borderRadius: 'var(--dsw-radius-xl, 12px)',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
        h('div', { style: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' } }, props.heading),
        props.children,
      )
    }

    /**
     * The settings card shown on the Plugins page.
     *
     * @param props - Slot props; the plugin reads its own copy from `TEXT`, so
     *   only the locale-independent parts are used.
     * @returns Card element.
     */
    function AttentionCard(props) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [failure, setFailure] = React.useState(false)
      const [testResult, setTestResult] = React.useState(null)
      /** True while the draft holds edits the Host has not accepted yet. */
      const [dirty, setDirty] = React.useState(false)
      const t = TEXT[detectLocale()]

      /**
       * The editable draft, in the units the form shows.
       *
       * The Host speaks milliseconds; this form is in seconds. Keeping the
       * conversion at this single boundary is what stops the two from drifting -
       * an earlier version converted on both edit and save, so typing 1 stored
       * 1000000 ms.
       * @param config - The Host's effective config.
       * @returns A draft whose duration is in seconds.
       */
      const toDraft = (config) => ({
        ...config,
        minDurationSeconds: typeof config?.minDurationMs === 'number'
          ? config.minDurationMs / 1000
          : 0,
      })

      React.useEffect(() => {
        let live = true
        const load = async () => {
          const state = await push('state', undefined)
          if (!live || state === undefined) {
            if (live) setFailure(true)
            return
          }
          setFailure(false)
          setSnapshot(state)
          // Never overwrite an edit that has not been written yet: the poll would
          // otherwise revert a control the user just changed, whenever the 5s tick
          // happens to land between the change and its autosave.
          setDirty((pending) => {
            if (pending !== true) setDraft((current) => current ?? toDraft(state.config))
            return pending
          })
        }
        void load()
        const timer = setInterval(() => {
          void load()
        }, 5000)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [])

      const patch = (mutate) => {
        setDraft((current) => {
          if (current === null) return current
          const next = structuredClone(current)
          mutate(next)
          return next
        })
        // Mark the edit as unsaved. This flag, rather than "the draft changed", is
        // what separates a user edit from a value the poll just delivered: saving on
        // every draft change would echo the poll straight back to the Host.
        setDirty(true)
      }

      /**
       * Persist the draft.
       * @param value - The draft to send; defaults to the current one.
       * @returns True when the Host accepted the write.
       */
      const save = async (value = draft) => {
        if (value === null || value === undefined) return false
        setFailure(false)
        const answer = await push('settings', {
          triggers: value.triggers,
          channels: value.channels,
          // The single seconds -> milliseconds conversion. A blank field means 0,
          // not "unsaved": the input can be empty mid-edit.
          minDurationMs: Math.round((Number(value.minDurationSeconds) || 0) * 1000),
          rawFallback: value.rawFallback,
        })
        if (answer?.ok !== true) {
          setStatus(t.saveFailed)
          setFailure(true)
          return false
        }
        setSnapshot((current) => ({ ...current, config: answer.config }))
        setDirty(false)
        setStatus(t.saved)
        return true
      }

      // Autosave. Every control in this card writes as soon as it changes, so there
      // is no Save button to forget; the debounce only coalesces a burst of edits
      // (and each keystroke in the duration field) into one write.
      React.useEffect(() => {
        if (dirty !== true || draft === null) return undefined
        setStatus(t.saving)
        const timer = setTimeout(() => {
          void save(draft)
        }, 500)
        return () => clearTimeout(timer)
        // `draft` is the payload and `dirty` the trigger; `save` is stable enough
        // for this purpose because it only reads `push` and the setters.
      }, [draft, dirty])

      const runTest = async (action) => {
        setTestResult({ action, pending: true })
        const answer = await push('test', { action })
        setTestResult({ action, pending: false, answer })
      }

      // The same card serves two seats: one line in the plugins list
      // (`view: 'summary'`) and the settings form on the bundle's detail page.
      // The list seat is a single description line, so it must not render the
      // form - doing that stretched the list into a page-sized panel.
      if (props?.view === 'summary') {
        return h('span', {}, t.summary)
      }

      if (failure && snapshot === null) {
        // Show the transport detail: "the request was rejected" and "the status was
        // not OK" need different fixes, and a bare failure message hides which.
        return h(Section, { heading: t.title },
          h('div', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)' } }, t.loadFailed),
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } },
            lastPushFailure ?? ''),
        )
      }
      if (draft === null) {
        return h(Section, { heading: t.title }, h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '…'))
      }

      const options = [
        { value: 'off', label: t.policyOff },
        { value: 'unfocused', label: t.policyUnfocused },
        { value: 'always', label: t.policyAlways },
      ]
      const trigger = (key, label) => h(SelectRow, {
        key,
        label,
        value: draft.triggers[key],
        options,
        onChange: (value) => patch((next) => {
          next.triggers[key] = value
        }),
      })
      const channel = (key, label) => h(Check, {
        key,
        label,
        checked: draft.channels[key],
        onChange: (value) => patch((next) => {
          next.channels[key] = value
        }),
      })
      const stats = snapshot?.stats
      const probe = snapshot?.probe

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, t.title),
          h('div', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } }, t.subtitle),
        ),
        !(stats?.supported ?? true)
          ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-state-warn-primary)' } }, t.unsupported)
          : null,
        h(Section, { heading: t.triggers },
          trigger('approval', t.approval),
          trigger('question', t.question),
          trigger('done', t.done),
          trigger('error', t.error),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
            h('label', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t.minDuration),
            h('input', {
              type: 'number',
              min: 0,
              // `step: 'any'` on purpose: a numeric step snaps typed values onto its
              // multiples, so a step of 5 would reject the perfectly valid "1".
              step: 'any',
              // The draft keeps this value in SECONDS; `save` converts once. The
              // earlier version stored milliseconds here and multiplied again on
              // save, so typing 1 produced 1000000 ms and read back as 1000.
              value: draft.minDurationSeconds,
              onChange: (event) => patch((next) => {
                const typed = Number(event.target.value)
                next.minDurationSeconds = Number.isFinite(typed) && typed >= 0 ? typed : 0
              }),
              style: {
                font: 'inherit',
                fontSize: 13,
                width: 120,
                padding: '4px 8px',
                borderRadius: 'var(--dsw-radius-md, 8px)',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-primary)',
              },
            }),
            h('span', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, t.minDurationHint),
          ),
        ),
        h(Section, { heading: t.window },
          channel('toast', t.toast),
          channel('sound', t.sound),
          channel('inApp', t.inApp),
          h(Check, {
            label: t.rawFallback,
            checked: draft.rawFallback === true,
            onChange: (value) => patch((next) => {
              next.rawFallback = value
            }),
          }),
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, t.rawFallbackHint),
        ),
        h(Section, { heading: t.test },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            h('button', { type: 'button', style: plainButtonStyle, onClick: () => void runTest('toast') }, t.testToast),
            h('button', { type: 'button', style: plainButtonStyle, onClick: () => void runTest('raw') }, t.testRaw),
            h('button', { type: 'button', style: plainButtonStyle, onClick: () => void runTest('sound') }, t.testSound),
            h('button', { type: 'button', style: plainButtonStyle, onClick: () => void runTest('focus') }, t.testFocus),
          ),
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
            stats?.supported
              ? `PowerShell: ${probe?.powershellPresent === true ? 'OK' : 'missing'} · 提示音: ${probe?.sound ?? '未找到'}`
              : t.unsupported,
          ),
          testResult !== null
            ? h('div', {
              style: {
                fontSize: 12,
                lineHeight: '18px',
                color: testResult.pending === true || testResult.answer?.ok === true
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-state-error-primary)',
              },
            }, testResult.pending === true
              ? '…'
              : testResult.answer?.ok === true
                ? `${testResult.action}: OK`
                : `${testResult.action}: ${String(testResult.answer?.error ?? lastPushFailure ?? 'failed')}`)
            : null,
        ),
        h(Section, { heading: t.status },
          h('div', { style: { fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', display: 'flex', flexDirection: 'column', gap: 2 } },
            h('div', {}, `${t.statusHost}: ${stats?.platform ?? '?'} · toast ok ${stats?.toastOk ?? 0} / fail ${stats?.toastFail ?? 0} · sound ok ${stats?.soundOk ?? 0} / fail ${stats?.soundFail ?? 0}`),
            h('div', {}, `${t.statusFocus}: ${snapshot?.focus?.reported === true ? `${t.reported} · ${snapshot.focus.visible ? t.visible : t.hidden}` : t.unreported}`),
            h('div', {}, `${t.statusObserved} ${formatObserved(snapshot?.observed)}`),
            h('div', {}, `${t.statusClient} ${String(snapshot?.client?.seen ?? 0)}`),
            h('div', {
              style: {
                color: snapshot?.clientProbe?.at
                  ? snapshot.clientProbe.ok === true
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-state-error-primary)'
                  : 'var(--dsw-alias-label-secondary)',
              },
            }, `${t.statusProbe} ${formatProbe(snapshot?.clientProbe, t)}`),
            stats?.lastError ? h('div', {}, `${t.statusResult}: ${String(stats.lastError)}`) : null,
          ),
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, t.approvalNote),
        ),
        // No Save button on purpose: every control writes itself. The line below
        // only reports what happened, and offers a retry when a write failed - the
        // one case where the user needs to act.
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', {
            style: {
              fontSize: 13,
              color: failure ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            },
          }, status),
          failure
            ? h('button', {
              type: 'button',
              onClick: () => {
                setDirty(true)
              },
              style: plainButtonStyle,
            }, t.retry)
            : null,
        ),
      )
    }

    /**
     * Pick a copy locale from the shell's language when it is reachable.
     * @returns `zh` or `en`.
     */
    function detectLocale() {
      try {
        const lang = document.documentElement?.lang ?? navigator.language ?? 'zh'
        return String(lang).toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    // ---- Plugin ---------------------------------------------------------------

    const inject = ['remote', 'slots']

    /**
     * Wire the page-level keep-alive listeners the plugin needs.
     *
     * Extracted so the wiring can be exercised without a browser; it only shows
     * the banner, so its failure mode is cosmetic.
     * @param target - Window-like object exposing `addEventListener`. Defaults to
     *   the real window when one exists.
     * @returns Dispose function removing every listener.
     */
    function startPageLifecycle(target = typeof window === 'undefined' ? undefined : window) {
      if (target === undefined || typeof target.addEventListener !== 'function') return () => {}
      const seen = []
      const onAlert = () => {
        try {
          seen.push(Date.now())
        } catch {
          // The banner still shows; this bookkeeping is only for diagnostics.
        }
      }
      const off = []
      for (const type of ['dsh-attention', 'visibilitychange', 'focus']) {
        target.addEventListener(type, onAlert)
        off.push(() => target.removeEventListener(type, onAlert))
      }
      return () => {
        for (const remove of off) remove()
      }
    }

    /**
     * Install the banner, the settings card, and the two
     * event-driven alerts.
     *
     * The alerts are raised here rather than on the Host because only the page
     * knows whether the user is actually looking at the window; the Host keeps
     * the system-level channels and the settings document.
     */
    function apply(ctx) {
      // Every step is isolated and logged. Isolation matters more than tidiness
      // here: a failing optional registration (one slot missing from this
      // deployment, say) must not prevent the alerts themselves from being wired,
      // and a page console that names the failing step turns a silent
      // half-working plugin into a one-line diagnosis.
      const failed = [];
      const step = (label, run) => {
        try {
          run();
          console.log(`[attention-notifier] ok: ${label}`);
        } catch (error) {
          failed.push(label);
          console.error(`[attention-notifier] STEP FAILED "${label}":`, error);
        }
      };

      if (ctx === undefined || ctx.slots === undefined || ctx.remote === undefined) {
        console.error('[attention-notifier] services unavailable; plugin disabled', {
          slots: ctx?.slots !== undefined,
          remote: ctx?.remote !== undefined,
        });
        return;
      }

      step('register shell.overlay', () => {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'attention-notifier',
          order: 60,
        }, AttentionNotice));
      });

      step('register plugins.item', () => {
        ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'attention-notifier',
          label: TEXT[detectLocale()].title,
          order: 40,
        }, AttentionCard));
      });

      step('register plugins.bundle.config', () => {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-attention-notifier',
          order: 40,
        }, AttentionCard));
      });

      step('page lifecycle effect', () => {
        ctx.effect(() => startPageLifecycle(), 'attention-notifier: page lifecycle');
      });

      step('instant focus reporting', () => {
        // Report a visibility change the moment it happens. The notice poll runs
        // every couple of seconds, and minimizing the window finishes a turn inside
        // that window: the idle decision would then read a focus state that was
        // still "visible" up to two seconds ago and suppress the very alert the user
        // is waiting for. A change event carries no such lag.
        ctx.effect(() => {
          const report = () => {
            const away = isAway();
            void push(`focus?signals=${encodeURIComponent(awaySignals())}`, { visible: !away });
          };
          const events = ['visibilitychange', 'focus', 'blur', 'pagehide', 'pageshow'];
          for (const type of events) {
            window.addEventListener(type, report);
            document.addEventListener(type, report);
          }
          return () => {
            for (const type of events) {
              window.removeEventListener(type, report);
              document.removeEventListener(type, report);
            }
          };
        }, 'attention-notifier: instant focus reporting');
      });

      step('route probe effect', () => {
        // Probe this page's own ability to reach the plugin's route, and report the
        // outcome through a GET so the answer still arrives when the request itself
        // cannot be read. The Electron window is served over `dsh-app://`, so this
        // is not obviously the same as a request from a browser tab.
        ctx.effect(() => {
          let cancelled = false;
          const run = async () => {
            const url = `${ROUTE}/state`;
            let report = { url, ok: '0', status: '', error: '', body: '' };
            try {
              const response = await fetch(url, { credentials: 'same-origin' });
              const text = await response.text();
              report = {
                url,
                ok: response.ok ? '1' : '0',
                status: String(response.status),
                error: '',
                // The body identifies the responder: a gateway rejection reads
                // differently from this plugin's own JSON.
                body: text.slice(0, 200),
              };
            } catch (error) {
              report.error = String(error?.message ?? error).slice(0, 200);
            }
            if (cancelled) return;
            const query = new URLSearchParams(report).toString();
            try {
              await fetch(`${ROUTE}/client-probe-report?${query}`, { credentials: 'same-origin' });
            } catch {
              // The report is itself best-effort.
            }
          };
          void run();
          return () => {
            cancelled = true;
          };
        }, 'attention-notifier: route probe');
      });

      step('approval listener', () => {
        // Both listeners must call `next()`: the shipped answerers run after this
        // one, and returning anything else would claim the request and leave the
        // user with no way to answer.
        ctx.remote.$on('approval/request', function (request, next) {
          try {
            if (isAway()) {
              const reason = request?.displayReason?.zh ?? request?.displayReason?.en ?? request?.reason;
              alertUser(
                'approval',
                `approval:${String(this?.id ?? '')}:${String(request?.callId ?? '')}:${String(request?.toolName ?? '')}`,
                '需要你确认权限',
                typeof reason === 'string' && reason.length > 0 ? reason : `${String(request?.toolName ?? '工具')} 请求越权执行`,
              );
            }
          } catch {
            // A failed alert must never break the approval flow.
          }
          return next();
        });
      });

      step('question listener', () => {
        ctx.remote.$on('user-questions/request', function (request, next) {
          try {
            const first = Array.isArray(request?.questions) ? request.questions[0] : undefined;
            if (isAway() && first !== undefined) {
              alertUser(
                'question',
                `question:${String(request?.wait?.callId ?? '')}`,
                first.intent?.kind === 'plan-review' ? '计划等待评审' : '需要你回答',
                String(first.question ?? '').slice(0, 300),
              );
            }
          } catch {
            // Same containment as above.
          }
          return next();
        });
      });

      step('notice poll', () => {
        // Completion and failure are not forwarded as Remote Events, so they are
        // polled from the Host snapshot. The poll only reports notices the Host has
        // already decided to raise, which keeps the focus policy in one place.
        const timer = setInterval(async () => {
          const state = await push(
            `state?cursor=${String(cursor)}&visible=${isAway() ? '0' : '1'}`
            + `&signals=${encodeURIComponent(awaySignals())}`,
            undefined,
          );
          if (state === undefined) return;
          const messages = Array.isArray(state.messages) ? state.messages : [];
          if (messages.length === 0) return;
          for (const message of messages) {
            cursor = Math.max(cursor, Number(message.seq) || 0);
            if (message.kind === 'done' || message.kind === 'error') {
              alertUser(
                message.kind,
                `${message.kind}:${String(message.seq)}`,
                String(message.title ?? ''),
                String(message.body ?? ''),
              );
            }
          }
        }, 2000);
        if (typeof timer.unref === 'function') timer.unref();
        ctx.effect(() => () => clearInterval(timer), 'attention-notifier: notice poll');
      });

      console.log(
        failed.length === 0
          ? '[attention-notifier] client half loaded (all steps ok)'
          : `[attention-notifier] client half loaded with failures: ${failed.join(', ')}`,
      );
    }

    return { inject, apply, startPageLifecycle }
  },
})
