import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '../../components/button.js';
import {
  emptyImageCell,
  imageCellIssue,
  imageCellWords,
  imageTargetLabel,
  type ImageBox,
  type ImageCell,
  type ImageInspection,
} from './finance-image-review-model.js';

export function ImageReviewSource({
  inspection,
  imageUrl,
  filename,
  target,
  cell,
  used,
  locked,
  imageReady,
  onReady,
  onChange,
  onWord,
  onRegion,
  onDone,
}: {
  inspection: ImageInspection;
  imageUrl: string;
  filename: string;
  target: string;
  cell: ImageCell;
  used: Map<string, string>;
  locked: boolean;
  imageReady: boolean;
  onReady: (ready: boolean) => void;
  onChange: (cell: ImageCell) => void;
  onWord: (id: string) => void;
  onRegion: (box: ImageBox) => void;
  onDone: () => void;
}) {
  const [zoom, setZoom] = useState(100),
    [draw, setDraw] = useState(false),
    [boxes, setBoxes] = useState(true);
  const [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [imageError, setImageError] = useState('');
  const [region, setRegion] = useState({ x: '', y: '', width: '', height: '' });
  const [dragBox, setDragBox] = useState<ImageBox>();
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const viewport = useRef<HTMLDivElement>(null);
  const facts = inspection.facts;
  useEffect(() => {
    const element = viewport.current;
    if (!element || !cell.region || zoom === 100) return;
    const scale = (element.clientWidth * zoom) / 100 / facts.width;
    element.scrollLeft = Math.max(
      0,
      (cell.region.x + cell.region.width / 2) * scale - element.clientWidth / 2,
    );
    element.scrollTop = Math.max(
      0,
      (cell.region.y + cell.region.height / 2) * scale -
        element.clientHeight / 2,
    );
  }, [zoom, cell.region, facts.width]);
  useEffect(() => {
    setRegion(
      cell.region
        ? {
            x: String(cell.region.x),
            y: String(cell.region.y),
            width: String(cell.region.width),
            height: String(cell.region.height),
          }
        : { x: '', y: '', width: '', height: '' },
    );
  }, [cell.region]);
  const selected = imageCellWords(cell, inspection),
    issue = imageCellIssue(cell, inspection);
  const filtered = facts.words.filter((word) =>
    word.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  function point(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          facts.width,
          Math.round(((event.clientX - rect.left) / rect.width) * facts.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          facts.height,
          Math.round(((event.clientY - rect.top) / rect.height) * facts.height),
        ),
      ),
    };
  }
  function boxFor(end: { x: number; y: number }): ImageBox | undefined {
    if (!start.current) return undefined;
    return {
      x: Math.min(start.current.x, end.x),
      y: Math.min(start.current.y, end.y),
      width: Math.abs(start.current.x - end.x),
      height: Math.abs(start.current.y - end.y),
    };
  }
  function finish(event: PointerEvent<SVGSVGElement>) {
    if (!start.current || locked) return;
    const end = point(event),
      box = boxFor(end)!;
    start.current = undefined;
    setDragBox(undefined);
    if (draw) {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      if (box.width && box.height) onRegion(box);
    } else if (box.width <= 4 && box.height <= 4) {
      const word = facts.words.find(
        (word) =>
          end.x >= word.box.x &&
          end.x <= word.box.x + word.box.width &&
          end.y >= word.box.y &&
          end.y <= word.box.y + word.box.height,
      );
      if (word && (!used.has(word.id) || used.get(word.id) === target))
        onWord(word.id);
    }
  }
  function change(next: Partial<ImageCell>) {
    onChange({ ...cell, ...next, confirmed: false });
  }
  return (
    <section
      className="finance-image-source-review"
      aria-label={`Review image cell: ${imageTargetLabel(target)}`}
    >
      <div className="finance-image-section-heading">
        <div>
          <span className="finance-image-eyebrow">Selected cell</span>
          <h5>{imageTargetLabel(target)}</h5>
          <p>
            Use the original pixels to establish this cell. OCR text is only a
            starting point.
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          disabled={locked}
          onClick={onDone}
        >
          Back to selected table
        </Button>
      </div>
      <div className="finance-image-source-layout">
        <div className="finance-image-original-column">
          <div className="finance-image-toolbar">
            <label>
              Image zoom
              <select
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              >
                <option value={100}>Fit width</option>
                <option value={150}>150%</option>
                <option value={200}>200%</option>
                <option value={300}>300%</option>
              </select>
            </label>
            <Button
              type="button"
              variant={draw ? 'primary' : 'secondary'}
              aria-pressed={draw}
              disabled={locked}
              onClick={() => setDraw(!draw)}
            >
              Draw pixel region
            </Button>
            <label className="finance-image-check">
              <input
                type="checkbox"
                checked={boxes}
                onChange={(event) => setBoxes(event.target.checked)}
              />
              Show OCR boxes
            </label>
          </div>
          <p className="finance-image-hint">
            {draw
              ? 'Drag a rectangle around this cell, or enter exact pixel bounds below. Include whole intersecting words.'
              : 'Select words on the image or use the searchable word list. At higher zoom, scroll to inspect the original.'}
          </p>
          {imageError && <p role="alert">{imageError}</p>}
          <div
            ref={viewport}
            className="finance-image-viewport"
            role="region"
            aria-label="Original image and pixel regions"
            tabIndex={0}
          >
            <div
              className="finance-image-pixels"
              style={{
                width: `${zoom}%`,
                aspectRatio: `${facts.width} / ${facts.height}`,
              }}
            >
              <img
                src={imageUrl}
                alt={`Original image: ${filename}`}
                draggable={false}
                onLoad={(event) => {
                  const valid =
                    event.currentTarget.naturalWidth === facts.width &&
                    event.currentTarget.naturalHeight === facts.height;
                  setImageError(
                    valid
                      ? ''
                      : 'The displayed image dimensions do not match the saved OCR. Reopen this source before reviewing.',
                  );
                  onReady(valid);
                }}
                onError={() => {
                  setImageError(
                    'The original image could not be displayed. Visual confirmation is unavailable.',
                  );
                  onReady(false);
                }}
              />
              <svg
                viewBox={`0 0 ${facts.width} ${facts.height}`}
                aria-hidden="true"
                className={draw ? 'is-drawing' : ''}
                onPointerDown={(event) => {
                  if (locked || !imageReady) return;
                  start.current = point(event);
                  if (draw) {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }
                }}
                onPointerMove={(event) => {
                  if (draw && start.current) setDragBox(boxFor(point(event)));
                }}
                onPointerUp={finish}
                onPointerCancel={() => {
                  start.current = undefined;
                  setDragBox(undefined);
                }}
              >
                {boxes &&
                  facts.words.map((word) => (
                    <rect
                      key={word.id}
                      {...word.box}
                      className={
                        cell.wordIds.includes(word.id)
                          ? 'is-selected'
                          : used.has(word.id)
                            ? 'is-assigned'
                            : word.confidenceStatus === 'high'
                              ? 'is-observed'
                              : 'is-uncertain'
                      }
                    />
                  ))}
                {cell.region && (
                  <rect {...cell.region} className="is-cell-region" />
                )}
                {dragBox && <rect {...dragBox} className="is-drag-region" />}
              </svg>
            </div>
          </div>
          <div className="finance-image-image-caption">
            <span>
              {facts.width} × {facts.height} pixels
            </span>
            <span>Coordinates start at the top left</span>
          </div>
          <details className="finance-image-word-inventory">
            <summary>Search all {facts.words.length} OCR words</summary>
            <label>
              Find OCR words
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
              />
            </label>
            {!filtered.length && (
              <p>
                No OCR words match. A visible region missed by OCR can be
                transcribed with an explanation.
              </p>
            )}
            <div className="finance-image-word-list">
              {filtered.slice(offset, offset + 40).map((word) => {
                const assigned = used.get(word.id),
                  chosen = cell.wordIds.includes(word.id);
                return (
                  <button
                    type="button"
                    key={word.id}
                    aria-label={`Select OCR word ${word.id}: ${word.text}`}
                    aria-pressed={chosen}
                    disabled={locked || (!!assigned && assigned !== target)}
                    onClick={() => onWord(word.id)}
                  >
                    <strong>{word.text}</strong>
                    <span>
                      {assigned && assigned !== target
                        ? imageTargetLabel(assigned)
                        : word.confidenceStatus === 'high'
                          ? 'Machine confidence high'
                          : 'Needs careful visual review'}
                    </span>
                    <small>
                      {word.box.x}, {word.box.y} · {word.box.width} ×{' '}
                      {word.box.height} px
                    </small>
                  </button>
                );
              })}
            </div>
            <div className="finance-image-actions">
              <Button
                type="button"
                variant="quiet"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 40))}
              >
                Previous words
              </Button>
              <span>
                {filtered.length ? offset + 1 : 0}–
                {Math.min(offset + 40, filtered.length)} of {filtered.length}
              </span>
              <Button
                type="button"
                variant="quiet"
                disabled={offset + 40 >= filtered.length}
                onClick={() => setOffset(offset + 40)}
              >
                Next words
              </Button>
            </div>
          </details>
        </div>
        <div className="finance-image-cell-editor">
          <h6>Source region</h6>
          <div className="finance-image-region-fields">
            {(['x', 'y', 'width', 'height'] as const).map((field) => (
              <label key={field}>
                {field === 'x'
                  ? 'Left · px'
                  : field === 'y'
                    ? 'Top · px'
                    : field === 'width'
                      ? 'Width · px'
                      : 'Height · px'}
                <input
                  type="number"
                  min={field === 'x' || field === 'y' ? 0 : 1}
                  step={1}
                  disabled={locked}
                  value={region[field]}
                  onChange={(event) =>
                    setRegion({ ...region, [field]: event.target.value })
                  }
                />
              </label>
            ))}
          </div>
          <div className="finance-image-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={
                locked || Object.values(region).some((value) => value === '')
              }
              onClick={() =>
                onRegion({
                  x: Number(region.x),
                  y: Number(region.y),
                  width: Number(region.width),
                  height: Number(region.height),
                })
              }
            >
              Use pixel region
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={locked}
              onClick={() => onChange(emptyImageCell())}
            >
              Clear this cell
            </Button>
          </div>
          <p>
            {selected.length} complete OCR{' '}
            {selected.length === 1 ? 'word' : 'words'} in this region.
          </p>
          <label>
            Join selected words
            <select
              value={cell.joiner}
              disabled={locked}
              onChange={(event) =>
                change({ joiner: event.target.value as '' | ' ' })
              }
            >
              <option value=" ">With a space</option>
              <option value="">Without a space</option>
            </select>
          </label>
          <div className="finance-image-raw-text">
            <span>Machine transcription</span>
            <p>
              {selected.length
                ? selected.map((word) => word.text).join(cell.joiner)
                : 'No OCR words selected'}
            </p>
          </div>
          {selected.length > 1 && (
            <details>
              <summary>Review word order</summary>
              {selected.map((word, index) => (
                <div className="finance-image-word-order" key={word.id}>
                  <span>
                    {index + 1}. {word.text}
                  </span>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={locked || index === 0}
                    aria-label={`Move ${word.text} earlier`}
                    onClick={() => {
                      const ids = [...cell.wordIds];
                      [ids[index - 1], ids[index]] = [
                        ids[index]!,
                        ids[index - 1]!,
                      ];
                      change({ wordIds: ids });
                    }}
                  >
                    Earlier
                  </Button>
                </div>
              ))}
            </details>
          )}
          <label>
            Text visible in this region
            <textarea
              disabled={locked}
              maxLength={10000}
              rows={2}
              value={cell.reviewedText}
              onChange={(event) => change({ reviewedText: event.target.value })}
            />
          </label>
          <label>
            Correction or missed-text explanation
            <textarea
              disabled={locked}
              maxLength={500}
              rows={2}
              value={cell.correctionReason}
              onChange={(event) =>
                change({ correctionReason: event.target.value })
              }
            />
            <small>
              Required when changing OCR text or transcribing a region with no
              OCR words.
            </small>
          </label>
          {issue && <p className="finance-image-cell-issue">{issue}</p>}
          <label className="finance-image-check finance-image-cell-confirm">
            <input
              type="checkbox"
              disabled={locked || !imageReady || !!issue}
              checked={cell.confirmed}
              onChange={(event) =>
                onChange({ ...cell, confirmed: event.target.checked })
              }
            />
            I checked this region and its exact text against the original image.
          </label>
          {!imageReady && (
            <p>
              Wait for the original image to display before confirming this
              cell.
            </p>
          )}
          <Button
            type="button"
            disabled={locked || !cell.confirmed}
            onClick={onDone}
          >
            Use reviewed cell
          </Button>
          <details className="finance-image-provenance">
            <summary>Pixel and word provenance</summary>
            <p>
              The selected word facts remain unchanged. Reviewed text and
              correction reasons are recorded separately.
            </p>
            <pre>
              {JSON.stringify(
                { region: cell.region, words: selected },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      </div>
    </section>
  );
}
