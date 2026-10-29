import { useEffect, useRef, useState } from 'react';
import type { EaselScene, EaselShape, Item } from '../../shared/model';
import { dispatch } from '../api';

/** Notes are local Markdown, edited in place (spec rebuild note: Notes become local Markdown). */
export function NoteEditor({ item }: { item: Item }) {
  const [text, setText] = useState(item.note?.markdown ?? '');
  const [preview, setPreview] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => setText(item.note?.markdown ?? ''), [item.id]);
  const onChange = (v: string) => {
    setText(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      dispatch({ type: 'note.update', id: item.id, markdown: v });
      const heading = /^#*\s*(.+)$/m.exec(v)?.[1]?.trim();
      if (heading && !item.title) dispatch({ type: 'item.rename', id: item.id, title: heading.slice(0, 60) });
    }, 300);
  };
  return (
    <div className="doc-pane">
      <div className="doc-toolbar">
        <button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Write</button>
        <button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Preview</button>
      </div>
      {preview ? (
        <article className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      ) : (
        <textarea className="note-text" autoFocus value={text} onChange={(e) => onChange(e.target.value)} placeholder="Start writing… (Markdown)" />
      )}
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A small, safe Markdown subset: headings, lists, quotes, code, bold/italic, links. */
export function renderMarkdown(md: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  let list: string | null = null;
  let code = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) {
      out.push(code ? '</code></pre>' : '<pre><code>');
      code = !code;
      continue;
    }
    if (code) {
      out.push(escapeHtml(line) + '\n');
      continue;
    }
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const tag = /\d/.test(li[1]!) ? 'ol' : 'ul';
      if (list !== tag) {
        if (list) out.push(`</${list}>`);
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${inline(li[2]!)}</li>`);
      continue;
    }
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
    else if (line.startsWith('> ')) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  if (code) out.push('</code></pre>');
  return out.join('');
}

// ── Easel: a local freeform canvas of strokes, text boxes and pasted images ──

type Shape = EaselShape;
type Scene = EaselScene;

export function EaselView({ item }: { item: Item }) {
  const [scene, setScene] = useState<Scene>(() => normalizeScene(item.easel?.scene));
  const [tool, setTool] = useState<'pen' | 'text'>('pen');
  const [color, setColor] = useState('#222222');
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Shape | null>(null);
  const images = useRef(new Map<string, HTMLImageElement>());

  useEffect(() => setScene(normalizeScene(item.easel?.scene)), [item.id]);

  const save = (next: Scene) => {
    setScene(next);
    dispatch({ type: 'easel.update', id: item.id, scene: next });
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of [...scene.shapes, ...(drawing.current ? [drawing.current] : [])]) drawShape(ctx, s, images.current, () => setScene((x) => ({ ...x })));
  });

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 480 / img.width);
          save({ shapes: [...scene.shapes, { kind: 'image', x: 40, y: 40, w: img.width * scale, h: img.height * scale, src: String(reader.result) }] });
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  return (
    <div className="doc-pane easel">
      <div className="doc-toolbar">
        <button className={tool === 'pen' ? 'on' : ''} onClick={() => setTool('pen')}>Draw</button>
        <button className={tool === 'text' ? 'on' : ''} onClick={() => setTool('text')}>Text</button>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <button onClick={() => save({ shapes: scene.shapes.slice(0, -1) })} disabled={!scene.shapes.length}>Undo</button>
        <span className="muted small">Paste an image to place it.</span>
      </div>
      <div className="easel-scroll">
      <canvas
        ref={canvas}
        className="easel-canvas"
        style={sceneExtent(scene)}
        onPointerDown={(e) => {
          const [x, y] = pos(e);
          if (tool === 'text') return setPendingText({ x, y });
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drawing.current = { kind: 'stroke', color, width: 3, points: [[x, y]] };
        }}
        onPointerMove={(e) => {
          if (drawing.current?.kind !== 'stroke') return;
          drawing.current.points.push(pos(e));
          setScene((s) => ({ ...s }));
        }}
        onPointerUp={() => {
          if (drawing.current) save({ shapes: [...scene.shapes, drawing.current] });
          drawing.current = null;
        }}
      />
      {pendingText && (
        <input
          className="easel-text-input"
          autoFocus
          style={{ left: pendingText.x, top: pendingText.y }}
          onBlur={() => setPendingText(null)}
          onKeyDown={(e) => {
            const text = (e.target as HTMLInputElement).value.trim();
            if (e.key === 'Enter' && text) save({ shapes: [...scene.shapes, { kind: 'text', x: pendingText.x, y: pendingText.y, text, color }] });
            if (e.key === 'Enter' || e.key === 'Escape') setPendingText(null);
          }}
        />
      )}
      </div>
    </div>
  );
}

/** Size the canvas to its content (imported Easels can be wider or taller than the pane); CSS keeps it at least pane-sized. */
function sceneExtent(scene: Scene): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const s of scene.shapes) {
    if (s.kind === 'stroke') for (const [x, y] of s.points) (w = Math.max(w, x)), (h = Math.max(h, y));
    else if (s.kind === 'text') (w = Math.max(w, s.x + (s.w ?? 300))), (h = Math.max(h, s.y + (s.size ?? 18) * 4));
    else (w = Math.max(w, s.x + s.w)), (h = Math.max(h, s.y + s.h));
  }
  return { width: Math.ceil(w + 40), height: Math.ceil(h + 40) };
}

function normalizeScene(raw: unknown): Scene {
  return raw && typeof raw === 'object' && Array.isArray((raw as Scene).shapes) ? (raw as Scene) : { shapes: [] };
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width?: number): string[] {
  if (!width) return [text];
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, cache: Map<string, HTMLImageElement>, rerender: () => void) {
  if (s.kind === 'stroke') {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  } else if (s.kind === 'text') {
    const size = s.size ?? 18;
    ctx.fillStyle = s.color;
    ctx.font = `${size}px ${s.font ?? 'system-ui, sans-serif'}`;
    wrapLines(ctx, s.text, s.w).forEach((line, i) => ctx.fillText(line, s.x, s.y + i * size * 1.25));
  } else {
    let img = cache.get(s.src);
    if (!img) {
      img = new Image();
      img.onload = rerender;
      img.src = s.src;
      cache.set(s.src, img);
    }
    if (img.complete) ctx.drawImage(img, s.x, s.y, s.w, s.h);
  }
}
