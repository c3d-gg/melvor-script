/**
 * Small floating panel inside the game: connection status, running jobs,
 * script log, Script Mode toggle and a big Stop button.
 */
import type { JobInfo, LogLevel } from '../shared/protocol.ts';

const STYLE = `
#ms-hud{position:fixed;right:16px;bottom:16px;width:360px;max-height:50vh;z-index:1040;display:flex;flex-direction:column;
  background:#1f2530;border:1px solid #3a4352;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.45);
  font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:#cfd6e2}
#ms-hud.ms-collapsed .ms-body{display:none}
#ms-hud .ms-head{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #3a4352;cursor:move;user-select:none}
#ms-hud .ms-title{font-weight:700;color:#fff;flex:1}
#ms-hud .ms-dot{width:8px;height:8px;border-radius:50%;background:#6b7280}
#ms-hud .ms-dot.on{background:#34d399}
#ms-hud .ms-dot.err{background:#f87171}
#ms-hud button{font:inherit;border:1px solid #4b5563;background:#2b3341;color:#e5e7eb;border-radius:4px;padding:1px 8px;cursor:pointer}
#ms-hud button:hover{background:#374151}
#ms-hud button.ms-stop{border-color:#b91c1c;background:#7f1d1d}
#ms-hud button.ms-mode.on{border-color:#059669;background:#064e3b}
#ms-hud .ms-body{display:flex;flex-direction:column;min-height:0}
#ms-hud .ms-status,#ms-hud .ms-jobs{padding:6px 8px;border-bottom:1px solid #2d3542;white-space:pre-wrap}
#ms-hud .ms-jobs:empty{display:none}
#ms-hud .ms-log{overflow:auto;padding:4px 8px;min-height:60px;flex:1}
#ms-hud .ms-line{white-space:pre-wrap;word-break:break-word}
#ms-hud .ms-t{color:#6b7280;margin-right:6px}
#ms-hud .ms-src{color:#93c5fd;margin-right:6px}
#ms-hud .ms-warn{color:#fbbf24}#ms-hud .ms-error{color:#f87171}#ms-hud .ms-success{color:#34d399}
`;

export interface HudCallbacks {
  onStopAll(): void;
  onToggleScriptMode(): void;
}

export class Hud {
  private root: HTMLDivElement | null = null;
  private style: HTMLStyleElement | null = null;
  private els: Record<string, HTMLElement> = {};
  private lines = 0;

  constructor(private cb: HudCallbacks) {}

  mount() {
    if (this.root || typeof document === 'undefined') return;
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);

    const root = document.createElement('div');
    root.id = 'ms-hud';
    root.innerHTML = `
      <div class="ms-head">
        <span class="ms-dot"></span>
        <span class="ms-title">Melvor Script</span>
        <button class="ms-mode" title="Script Mode: nothing repeats unless a script asks for it">script mode</button>
        <button class="ms-stop" title="Cancel every script job and stop the current action">stop</button>
        <button class="ms-min" title="Collapse">_</button>
      </div>
      <div class="ms-body">
        <div class="ms-status"></div>
        <div class="ms-jobs"></div>
        <div class="ms-log"></div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    const q = (s: string) => root.querySelector(s) as HTMLElement;
    this.els = {
      dot: q('.ms-dot'),
      mode: q('.ms-mode'),
      stop: q('.ms-stop'),
      min: q('.ms-min'),
      status: q('.ms-status'),
      jobs: q('.ms-jobs'),
      log: q('.ms-log'),
      head: q('.ms-head'),
    };
    this.els.stop.addEventListener('click', () => this.cb.onStopAll());
    this.els.mode.addEventListener('click', () => this.cb.onToggleScriptMode());
    this.els.min.addEventListener('click', () => root.classList.toggle('ms-collapsed'));
    this.makeDraggable(root, this.els.head);
    try {
      if (localStorage.getItem('melvor-script-hud-hidden') === '1') root.style.display = 'none';
    } catch {
      /* storage unavailable */
    }
  }

  unmount() {
    this.root?.remove();
    this.style?.remove();
    this.root = null;
    this.style = null;
  }

  toggle() {
    if (!this.root) return;
    const hidden = this.root.style.display === 'none';
    this.root.style.display = hidden ? '' : 'none';
    try {
      localStorage.setItem('melvor-script-hud-hidden', hidden ? '0' : '1');
    } catch {
      /* storage unavailable */
    }
  }

  setStatus(text: string, state: 'on' | 'off' | 'err') {
    if (!this.root) return;
    this.els.status.textContent = text;
    this.els.dot.className = `ms-dot ${state === 'on' ? 'on' : state === 'err' ? 'err' : ''}`;
  }

  /** `label` replaces the toggle text when the mode is fixed (instant actions). */
  setScriptMode(enabled: boolean, label?: string) {
    if (!this.root) return;
    this.els.mode.classList.toggle('on', enabled);
    this.els.mode.textContent = label ?? (enabled ? 'script mode: on' : 'script mode: off');
    if (label)
      this.els.mode.title = 'Instant actions: every action happens at once, then a cooldown of its normal time ÷ speed';
  }

  setJobs(jobs: JobInfo[], name: (id: string) => string) {
    if (!this.root) return;
    this.els.jobs.textContent = jobs
      .map((j) => {
        const progress = j.requested === null ? `${j.completed}/∞` : `${j.completed}/${j.requested}`;
        const targets = j.targets.map(name).join(', ');
        return `▶ ${name(j.skill)}${targets ? ` · ${targets}` : ''}  ${progress}  (${j.owner})`;
      })
      .join('\n');
  }

  log(level: LogLevel, message: string, source: string) {
    if (!this.root) return;
    const line = document.createElement('div');
    line.className = `ms-line ms-${level}`;
    const t = document.createElement('span');
    t.className = 'ms-t';
    t.textContent = new Date().toLocaleTimeString();
    const src = document.createElement('span');
    src.className = 'ms-src';
    src.textContent = source;
    line.append(t, src, document.createTextNode(message));
    const log = this.els.log;
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.appendChild(line);
    if (++this.lines > 300) {
      log.firstChild?.remove();
      this.lines--;
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  private makeDraggable(root: HTMLElement, handle: HTMLElement) {
    handle.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      const rect = root.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      const move = (ev: MouseEvent) => {
        root.style.left = `${Math.max(0, ev.clientX - dx)}px`;
        root.style.top = `${Math.max(0, ev.clientY - dy)}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }
}
