import { postAction } from './state';
export interface TaskOffer {
  id: number;
  sessionId: string;
  title: string;
  pending: number;
}
export const TASK_OFFER_CSS =
  '.dsh-pet-task-offer{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% - var(--dsh-pet-size,var(--pet-size,320px))*.108);z-index:8;box-sizing:border-box;width:max-content;max-width:min(230px,98%);padding:10px 12px;border:1px solid #dce6f0;border-radius:14px;background:rgba(255,255,255,.97);box-shadow:0 3px 14px #253a5826;color:#253650;font:12px/1.6 "Microsoft YaHei",sans-serif;pointer-events:auto}.dsh-pet-task-offer strong{display:block;font-weight:600}.dsh-pet-task-offer small{display:block;overflow-wrap:anywhere;color:#60718a}.dsh-pet-task-offer-actions{display:flex;gap:6px;margin-top:7px}.dsh-pet-task-offer button{border:1px solid #cdddeb;border-radius:8px;padding:4px 7px;font:inherit;cursor:pointer;background:#f2f7fc;color:#2d516e}.dsh-pet-task-offer button:first-child{background:#dceeff}.dsh-pet-task-offer button:disabled{opacity:.6;cursor:wait}';

/** Non-modal choice. A response carries its offer id, so an old click cannot select another task. */
export function mountTaskOffer(options: {
  parent: HTMLElement;
  offer: TaskOffer;
  baseUrl: string;
  onClose?: () => void;
}): { close: () => void } {
  if (!document.querySelector('style[data-task-offer]')) {
    const style = document.createElement('style');
    style.dataset.taskOffer = '';
    style.textContent = TASK_OFFER_CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'dsh-pet-task-offer';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '新任务模式选择');
  const title = document.createElement('strong');
  title.textContent = '发现新任务，切换任务模式？';
  const source = document.createElement('small');
  source.textContent =
    options.offer.title + (options.offer.pending > 1 ? '（另有 ' + (options.offer.pending - 1) + ' 个任务）' : '');
  const actions = document.createElement('div');
  actions.className = 'dsh-pet-task-offer-actions';
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.remove();
    options.onClose?.();
  };
  const buttons: HTMLButtonElement[] = [];
  for (const [label, accept] of [
    ['进入任务模式', true],
    ['继续挂机', false],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      for (const b of buttons) b.disabled = true;
      postAction(options.baseUrl, { offerId: options.offer.id, accept })
        .then((ok) => {
          if (closed) return;
          if (ok) close();
          else {
            source.textContent = '任务状态已变化，请稍候重试';
            for (const b of buttons) b.disabled = false;
          }
        })
        .catch(() => {
          if (!closed) {
            source.textContent = '暂时无法切换，请重试';
            for (const b of buttons) b.disabled = false;
          }
        });
    });
    buttons.push(button);
    actions.appendChild(button);
  }
  for (const name of ['pointerdown', 'pointerup', 'contextmenu'])
    root.addEventListener(name, (event) => event.stopPropagation());
  root.append(title, source, actions);
  options.parent.appendChild(root);
  return { close };
}
