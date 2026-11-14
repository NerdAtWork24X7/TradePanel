/**
 * HL Scalp Indicators
 *
 * Port of `custom_pine/my_indicator` (Pine v6) to the lightweight-charts-
 * indicators module convention. It bundles the reference script's overlay
 * studies into one calculation:
 *
 *   - EMA(low) / EMA(high) of the reference inputs, EMA 9 / EMA 20 of close;
 *   - session VWAP with up to three standard-deviation (or percentage) bands
 *     and the reference's two band fills;
 *   - UTC session high / low boxes with their name labels;
 *   - the previous calendar day's volume profile (VAH / VAL / POC lines);
 *   - normalized-volume bubbles, heat-map colouring, volume labels and the
 *     significant-volume level lines.
 *
 * Deviations from a literal line-by-line port, all inside this file:
 *   - `line.all` / `label.all` are scoped to the reference's own volume
 *     drawings instead of the global registry, so trimming significant-volume
 *     levels cannot delete the session boxes or the profile lines;
 *   - a profile with more than 1000 price rows is bucketed into 1000 rows
 *     (the reference allocates one array slot per row and can freeze the tab
 *     on a tiny `syminfo.mintick`).
 */
import {
  Series,
  ta,
  getSourceSeries,
  barTime,
  barInterval,
  color,
  timeframe as pineTimeframe,
} from 'oakscriptjs';
import {
  backgroundColorOf,
  chartTimeframe,
  foregroundColorOf,
  mintickOf,
} from 'lightweight-charts-indicators/helpers';

/** @typedef {import('oakscriptjs').Bar} Bar */
/** @typedef {import('oakscriptjs').InputConfig} InputConfig */
/** @typedef {import('oakscriptjs').PlotConfig} PlotConfig */

/** @type {{ showSession: boolean, asiaSession: string, londonSession: string, nyAmSession: string, nyPmSession: string, emaLength: number, emaLowSource: string, emaHighSource: string, emaOffset: number, showVwap: boolean, showVwapBand: boolean, hideVwapDwm: boolean, vwapAnchor: string, vwapSource: string, vwapOffset: number, bandMode: string, showBand1: boolean, bandMult1: number, showBand2: boolean, bandMult2: number, showBand3: boolean, bandMult3: number, showVolumeProfile: boolean, vpRowTicks: number, vpValueAreaPct: number, bubbles: boolean, threshold: number, heatmap: boolean, showLevels: boolean, levelsQty: number }} MyIndicatorInputs */
export const defaultInputs = {
  showSession: true,
  asiaSession: '0000-0015',
  londonSession: '0700-0715',
  nyAmSession: '1200-1215',
  nyPmSession: '1700-1715',
  emaLength: 50,
  emaLowSource: 'low',
  emaHighSource: 'high',
  emaOffset: 0,
  showVwap: false,
  showVwapBand: false,
  hideVwapDwm: false,
  vwapAnchor: 'Session',
  vwapSource: 'hlc3',
  vwapOffset: 0,
  bandMode: 'Standard Deviation',
  showBand1: false,
  bandMult1: 1.0,
  showBand2: false,
  bandMult2: 2.0,
  showBand3: false,
  bandMult3: 3.0,
  showVolumeProfile: true,
  vpRowTicks: 1,
  vpValueAreaPct: 70,
  bubbles: true,
  threshold: 1,
  heatmap: false,
  showLevels: false,
  levelsQty: 10,
};

const ANCHOR_OPTIONS = [
  'Session',
  'Week',
  'Month',
  'Quarter',
  'Year',
  'Decade',
  'Century',
  'Earnings',
  'Dividends',
  'Splits',
];

/** @type {InputConfig[]} */
export const inputConfig = [
  { id: 'showSession', type: 'bool', title: 'Show Session High/Low', defval: true, group: 'Sessions' },  { id: 'asiaSession', type: 'string', title: 'Asia (1st 15m, UTC)', defval: '0000-0015', group: 'Sessions' },
  { id: 'londonSession', type: 'string', title: 'London (1st 15m, UTC)', defval: '0700-0715', group: 'Sessions' },
  { id: 'nyAmSession', type: 'string', title: 'NY AM (1st 15m, UTC)', defval: '1200-1215', group: 'Sessions' },
  { id: 'nyPmSession', type: 'string', title: 'NY PM (1st 15m, UTC)', defval: '1700-1715', group: 'Sessions' },
  { id: 'emaLength', type: 'int', title: 'Length', defval: 50, min: 1, group: 'EMAs' },
  { id: 'emaLowSource', type: 'source', title: 'Low source', defval: 'low', group: 'EMAs' },
  { id: 'emaHighSource', type: 'source', title: 'High source', defval: 'high', group: 'EMAs' },
  { id: 'emaOffset', type: 'int', title: 'Offset', defval: 0, min: -500, max: 500, group: 'EMAs' },
  { id: 'showVwap', type: 'bool', title: 'Show VWAP', defval: false, group: 'VWAP Settings' },
  { id: 'showVwapBand', type: 'bool', title: 'Show VWAP band fills', defval: false, group: 'Bands Settings' },
  {
    id: 'hideVwapDwm',
    type: 'bool',
    title: 'Hide VWAP on 1D or Above',
    defval: false,
    group: 'VWAP Settings',
  },
  {
    id: 'vwapAnchor',
    type: 'string',
    title: 'Anchor Period',
    defval: 'Session',
    options: ANCHOR_OPTIONS,
    group: 'VWAP Settings',
  },
  { id: 'vwapSource', type: 'source', title: 'Source', defval: 'hlc3', group: 'VWAP Settings' },
  { id: 'vwapOffset', type: 'int', title: 'Offset', defval: 0, min: 0, group: 'VWAP Settings' },
  {
    id: 'bandMode',
    type: 'string',
    title: 'Bands Calculation Mode',
    defval: 'Standard Deviation',
    options: ['Standard Deviation', 'Percentage'],
    tooltip: "When 'Percentage' is selected, a multiplier of 1 means 1%.",
    group: 'Bands Settings',
  },
  { id: 'showBand1', type: 'bool', title: '', defval: false, group: 'Bands Settings', inline: 'band_1' },
  {
    id: 'bandMult1',
    type: 'float',
    title: 'Bands Multiplier #1',
    defval: 1.0,
    min: 0,
    step: 0.5,
    group: 'Bands Settings',
    inline: 'band_1',
    active: 'showBand1',
  },
  { id: 'showBand2', type: 'bool', title: '', defval: false, group: 'Bands Settings', inline: 'band_2' },
  {
    id: 'bandMult2',
    type: 'float',
    title: 'Bands Multiplier #2',
    defval: 2.0,
    min: 0,
    step: 0.5,
    group: 'Bands Settings',
    inline: 'band_2',
    active: 'showBand2',
  },
  { id: 'showBand3', type: 'bool', title: '', defval: false, group: 'Bands Settings', inline: 'band_3' },
  {
    id: 'bandMult3',
    type: 'float',
    title: 'Bands Multiplier #3',
    defval: 3.0,
    min: 0,
    step: 0.5,
    group: 'Bands Settings',
    inline: 'band_3',
    active: 'showBand3',
  },
  { id: 'showVolumeProfile', type: 'bool', title: 'Show Volume Profile', defval: true, group: 'Volume Profile' },
  {
    id: 'vpRowTicks',
    type: 'int',
    title: 'Row Size (Ticks)',
    defval: 1,
    min: 1,
    max: 50,
    group: 'Volume Profile',
  },
  {
    id: 'vpValueAreaPct',
    type: 'int',
    title: 'Value Area Volume %',
    defval: 70,
    min: 50,
    max: 100,
    group: 'Volume Profile',
  },
  { id: 'bubbles', type: 'bool', title: 'Show volume bubbles', defval: true, group: 'Bubbles', inline: 'bubbles' },
  {
    id: 'threshold',
    type: 'float',
    title: 'Threshold',
    defval: 1,
    min: 0,
    max: 7,
    step: 0.1,
    group: 'Bubbles',
    inline: 'bubbles',
  },
  { id: 'heatmap', type: 'bool', title: 'HeatMap', defval: false, group: 'Bubbles' },
  { id: 'showLevels', type: 'bool', title: 'Significant Volume Levels', defval: false, group: 'Volume Levels' },
  {
    id: 'levelsQty',
    type: 'int',
    title: 'Levels Qty',
    defval: 10,
    min: 1,
    group: 'Volume Levels',
  },
];

/** @type {PlotConfig[]} */
export const plotConfig = [
  { id: 'plot0', title: 'EMA low', color: '#2962FF' },
  { id: 'plot1', title: 'EMA high', color: '#2962FF' },
  { id: 'plot2', title: 'EMA9', color: '#00BCD4' },
  { id: 'plot3', title: 'EMA20', color: '#FF9800' },
  { id: 'plot4', title: 'VWAP', color: '#FF9800', style: 'circles', lineWidth: 2, visible: 'vwap' },
  { id: 'plot5', title: 'Upper Band #1', color: '#808080', visible: 'band1' },
  { id: 'plot6', title: 'Lower Band #1', color: '#808080', visible: 'band1' },
  { id: 'plot7', title: 'Upper Band #2', color: '#F23645', visible: 'band2' },
  { id: 'plot8', title: 'Lower Band #2', color: '#089981', visible: 'band2' },
  { id: 'plot9', title: 'Upper Band #3', color: '#F23645', visible: 'band3' },
  { id: 'plot10', title: 'Lower Band #3', color: '#089981', visible: 'band3' },
];

export const metadata = {
  title: 'my_indicator',
  shortTitle: 'my_indicator',
  overlay: true,
};

const SESSION_DEFS = [
  { name: 'Asia', color: '#2196F3' },
  { name: 'London', color: '#9C27B0' },
  { name: 'NY AM', color: '#00897B' },
  { name: 'NY PM', color: '#FF9800' },
];

const MAX_SESSION_OBJECTS = 250;
const MAX_PROFILE_LINES = 500;

/** Milliseconds of a bar time (seconds or milliseconds). */
function toMillis(time) {
  return time < 1e12 ? time * 1000 : time;
}

/** Minute of the UTC day (0..1439). */
function utcMinute(time) {
  const date = new Date(toMillis(time));
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** `"HHMM-HHMM"` -> `{ start, end }` minutes; null when the text is malformed. */
function parseSession(text) {
  const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  return {
    start: Number(match[1]) * 60 + Number(match[2]),
    end: Number(match[3]) * 60 + Number(match[4]),
  };
}

/** PineScript `time("", session, "UTC")` for one bar. */
function inSession(time, session) {
  if (!session) return false;
  const minute = utcMinute(time);
  return session.start <= session.end
    ? minute >= session.start && minute < session.end
    : minute >= session.start || minute < session.end;
}

/** UTC calendar-day key of a bar time. */
function utcDayKey(time) {
  const date = new Date(toMillis(time));
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86400000,
  );
}

/** Pine `timeframe.change(<anchor>)` key of one bar, in UTC. */
function anchorKey(time, anchor) {
  const date = new Date(toMillis(time));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  switch (anchor) {
    case 'Week':
      return Math.floor(toMillis(time) / 86400000) - ((date.getUTCDay() + 6) % 7);
    case 'Month':
      return year * 12 + month;
    case 'Quarter':
      return year * 4 + Math.floor(month / 3);
    case 'Year':
      return year;
    default:
      return utcDayKey(time);
  }
}

/** Pine `plot(..., offset = k)`: bar i is drawn at bar i + k. */
function shifted(bars, values, offset, interval) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i + offset < 0) continue;
    out.push({ time: barTime(bars, i + offset, interval), value: values[i] });
  }
  return out;
}

/** Pine `format.volume` (compact notation, three decimals at most). */
function formatVolume(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = abs / size;
      const text = scaled >= 100 ? scaled.toFixed(1) : scaled.toFixed(3);
      return sign + text.replace(/\.?0+$/, '') + suffix;
    }
  }
  return sign + String(Math.round(abs));
}

/**
 * Previous calendar day's profile, as the reference computes it: one row per
 * `vpRowTicks` ticks, volume distributed by the overlap of each bar with each
 * row, then a value area expanding from the POC to the larger neighbour.
 */
function previousDayProfile(bars, start, end, tick, rowTicks, valueAreaPct) {
  let high = bars[start].high;
  let low = bars[start].low;
  for (let i = start + 1; i <= end; i++) {
    high = Math.max(high, bars[i].high);
    low = Math.min(low, bars[i].low);
  }
  const range = high - low;
  if (!(range > 0) || !(tick > 0)) return null;

  let rowSize = tick * rowTicks;
  let rows = Math.max(1, Math.ceil(range / rowSize));
  // Guard for symbols with a very small tick: keep the profile bounded.
  if (rows > 1000) {
    rows = 1000;
    rowSize = range / rows;
  }
  const volumes = new Float64Array(rows);

  for (let i = start; i <= end; i++) {
    const barHigh = bars[i].high;
    const barLow = bars[i].low;
    const barRange = barHigh - barLow;
    if (!(barRange > 0)) continue;
    const volume = Number.isFinite(bars[i].volume) ? bars[i].volume : 0;
    if (!volume) continue;
    for (let j = 0; j < rows; j++) {
      const rowLow = low + j * rowSize;
      const rowHigh = Math.min(rowLow + rowSize, high);
      if (barHigh >= rowLow && barLow <= rowHigh) {
        const overlap = Math.min(barHigh, rowHigh) - Math.max(barLow, rowLow);
        if (overlap > 0) volumes[j] += volume * (overlap / barRange);
      }
    }
  }

  let total = 0;
  for (let j = 0; j < rows; j++) total += volumes[j];
  let poc = 0;
  for (let j = 1; j < rows; j++) if (volumes[j] > volumes[poc]) poc = j;

  const target = total * valueAreaPct / 100;
  let cumulative = volumes[poc];
  let valueLow = poc;
  let valueHigh = poc;
  const used = new Uint8Array(rows);
  used[poc] = 1;
  let safety = rows;
  while (cumulative < target && safety-- > 0) {
    const left = valueLow - 1;
    const right = valueHigh + 1;
    const hasLeft = left >= 0 && !used[left];
    const hasRight = right < rows && !used[right];
    if (!hasLeft && !hasRight) break;
    if (hasLeft && (!hasRight || volumes[left] >= volumes[right])) {
      used[left] = 1;
      cumulative += volumes[left];
      valueLow = left;
    } else {
      used[right] = 1;
      cumulative += volumes[right];
      valueHigh = right;
    }
  }

  return {
    vah: low + (valueHigh + 1) * rowSize,
    val: low + valueLow * rowSize,
    poc: low + (poc + 0.5) * rowSize,
  };
}

/**
 * @param {Bar[]} bars
 * @param {Partial<MyIndicatorInputs>=} inputs
 * @param {Record<string, unknown>=} chart
 */
export function calculate(bars, inputs = {}, chart = {}) {
  const cfg = { ...defaultInputs, ...inputs };
  const n = bars.length;
  const toArray = (series) => series.toArray().map((value) => (value == null ? NaN : Number(value)));
  const nan = () => new Array(n).fill(NaN);
  const interval = barInterval(bars);

  if (!n) {
    const empty = {};
    for (const plot of plotConfig) empty[plot.id] = [];
    return {
      metadata: { title: metadata.title, shorttitle: metadata.shortTitle, overlay: metadata.overlay },
      plots: empty,
      fills: [],
      visibility: { vwap: false, band1: false, band2: false, band3: false },
      labels: [],
      boxes: [],
      lines: [],
      markers: [],
    };
  }

  /* ── EMAs ──────────────────────────────────────────────────────────────── */
  const emaLength = Math.max(1, Math.floor(cfg.emaLength));
  const emaLow = toArray(ta.ema(getSourceSeries(bars, cfg.emaLowSource), emaLength));
  const emaHigh = toArray(ta.ema(getSourceSeries(bars, cfg.emaHighSource), emaLength));
  const ema9 = toArray(ta.ema(getSourceSeries(bars, 'close'), 9));
  const ema20 = toArray(ta.ema(getSourceSeries(bars, 'close'), 20));

  /* ── VWAP + bands ──────────────────────────────────────────────────────── */
  const vwapSource = getSourceSeries(bars, cfg.vwapSource);
  const vwapSourceValues = toArray(vwapSource);
  const volumeSeries = new Series(bars, (bar) => (Number.isFinite(bar.volume) ? bar.volume : NaN));
  const volumeValues = toArray(volumeSeries);
  const esdAnchor =
    cfg.vwapAnchor === 'Earnings' || cfg.vwapAnchor === 'Dividends' || cfg.vwapAnchor === 'Splits';

  const anchorResets = new Array(n).fill(false);
  let anchorPrev = NaN;
  for (let i = 0; i < n; i++) {
    if (esdAnchor) break;
    const key = cfg.vwapAnchor === 'Decade'
      ? anchorKey(bars[i].time, 'Year') * 10 + Math.floor(new Date(toMillis(bars[i].time)).getUTCFullYear() % 10)
      : cfg.vwapAnchor === 'Century'
        ? Math.floor(new Date(toMillis(bars[i].time)).getUTCFullYear() / 100)
        : anchorKey(bars[i].time, cfg.vwapAnchor);
    const changed = i > 0 && key !== anchorPrev;
    anchorPrev = key;
    const year = new Date(toMillis(bars[i].time)).getUTCFullYear();
    if (cfg.vwapAnchor === 'Decade') anchorResets[i] = changed && year % 10 === 0;
    else if (cfg.vwapAnchor === 'Century') anchorResets[i] = changed && year % 100 === 0;
    else anchorResets[i] = changed;
    if (i === 0 || Number.isNaN(vwapSourceValues[i - 1])) anchorResets[i] = true;
  }

  const dayMs = bars[0].time < 1e12 ? 86400 : 86400000;
  const isDwm = chart && chart.timeframe
    ? pineTimeframe.info(chartTimeframe(bars, chart)).isdwm
    : interval >= dayMs;
  const vwapHidden = esdAnchor || (cfg.hideVwapDwm && isDwm);

  let vwapValues = nan();
  const bandValues = [nan(), nan(), nan(), nan(), nan(), nan()];
  if (!vwapHidden) {
    const vwapResult = /** @type {[import('oakscriptjs').Series, import('oakscriptjs').Series]} */ (
      ta.vwapBands(vwapSource, volumeSeries, Series.fromArray(bars, anchorResets), 1)
    );
    const vwapRaw = toArray(vwapResult[0]);
    const upperRaw = toArray(vwapResult[1]);
    const multipliers = [cfg.bandMult1, cfg.bandMult2, cfg.bandMult3];
    for (let i = 0; i < n; i++) {
      const value = vwapRaw[i];
      const stdevAbs = upperRaw[i] - value;
      const basis = cfg.bandMode === 'Standard Deviation' ? stdevAbs : value * 0.01;
      vwapValues[i] = value;
      for (let k = 0; k < 3; k++) {
        bandValues[2 * k][i] = value + basis * multipliers[k];
        bandValues[2 * k + 1][i] = value - basis * multipliers[k];
      }
    }
  }

  const emaOffset = Math.trunc(cfg.emaOffset) || 0;
  const vwapOffset = Math.trunc(cfg.vwapOffset) || 0;

  const plots = {
    plot0: shifted(bars, emaLow, emaOffset, interval),
    plot1: shifted(bars, emaHigh, emaOffset, interval),
    plot2: shifted(bars, ema9, emaOffset, interval),
    plot3: shifted(bars, ema20, emaOffset, interval),
    plot4: shifted(bars, vwapValues, vwapOffset, interval),
    plot5: shifted(bars, bandValues[0], vwapOffset, interval),
    plot6: shifted(bars, bandValues[1], vwapOffset, interval),
    plot7: shifted(bars, bandValues[2], vwapOffset, interval),
    plot8: shifted(bars, bandValues[3], vwapOffset, interval),
    plot9: shifted(bars, bandValues[4], vwapOffset, interval),
    plot10: shifted(bars, bandValues[5], vwapOffset, interval),
  };

  const showBands = !vwapHidden && cfg.showVwap;
  const visibility = {
    vwap: showBands,
    band1: showBands && cfg.showBand1,
    band2: showBands && cfg.showBand2,
    band3: showBands && cfg.showBand3,
  };
  const fills = [];
  if (showBands && cfg.showVwapBand && cfg.showBand2) {
    fills.push({
      id: 'fill_upper_2',
      plot1: 'plot7',
      plot2: 'plot9',
      options: { color: '#F23645', transp: 95, title: 'Bands Fill #2' },
    });
  }
  if (showBands && cfg.showVwapBand && cfg.showBand3) {
    fills.push({
      id: 'fill_lower_3',
      plot1: 'plot8',
      plot2: 'plot10',
      options: { color: '#089981', transp: 95, title: 'Bands Fill #3' },
    });
  }

  /* ── Session high / low boxes ──────────────────────────────────────────── */
  /** @type {Array<{ time: number; price: number; text: string; color: string; textColor: string; style: string; size: string }>} */
  const labels = [];
  /** @type {Array<{ time1: number; price1: number; time2: number; price2: number; bgColor: string; borderColor: string; borderWidth: number }>} */
  const boxes = [];

  if (cfg.showSession) {
    const sessions = [
      parseSession(cfg.asiaSession),
      parseSession(cfg.londonSession),
      parseSession(cfg.nyAmSession),
      parseSession(cfg.nyPmSession),
    ];
    let active = null;
    const found = [];
    for (let i = 0; i < n; i++) {
      let index = -1;
      for (let s = 0; s < sessions.length; s++) {
        if (inSession(bars[i].time, sessions[s])) {
          index = s;
          break;
        }
      }
      if (index < 0) {
        active = null;
        continue;
      }
      if (!active || active.index !== index) {
        active = {
          index,
          start: i,
          high: bars[i].high,
          low: bars[i].low,
        };
        found.push(active);
      } else {
        active.high = Math.max(active.high, bars[i].high);
        active.low = Math.min(active.low, bars[i].low);
      }
    }

    for (let s = 0; s < found.length; s++) {
      const session = found[s];
      const end = (found[s + 1] ? found[s + 1].start : n) - 1;
      if (end < session.start) continue;
      const def = SESSION_DEFS[session.index];
      const tint = color.new(def.color, 90);
      boxes.push({
        time1: bars[session.start].time,
        price1: session.high,
        time2: bars[end].time,
        price2: session.low,
        bgColor: tint,
        borderColor: tint,
        borderWidth: 1,
      });
      labels.push({
        time: bars[session.start].time,
        price: session.high,
        text: def.name,
        color: def.color,
        textColor: '#FFFFFF',
        style: 'label_down',
        size: 'small',
      });
    }
    if (boxes.length > MAX_SESSION_OBJECTS) {
      boxes.splice(0, boxes.length - MAX_SESSION_OBJECTS);
      labels.splice(0, labels.length - MAX_SESSION_OBJECTS);
    }
  }

  /* ── Previous-day volume profile ───────────────────────────────────────── */
  /** @type {Array<{ time1: number; price1: number; time2: number; price2: number; color: string; width: number; style: string }>} */
  const lines = [];
  if (cfg.showVolumeProfile && n > 1) {
    const dayStarts = [0];
    for (let i = 1; i < n; i++) {
      if (utcDayKey(bars[i].time) !== utcDayKey(bars[i - 1].time)) dayStarts.push(i);
    }
    const tick = mintickOf(chart);
    const rowTicks = Math.max(1, Math.round(cfg.vpRowTicks));
    const valueAreaPct = Math.min(100, Math.max(50, cfg.vpValueAreaPct));
    for (let k = 1; k < dayStarts.length; k++) {
      const profileStart = dayStarts[k - 1];
      const profileEnd = dayStarts[k] - 1;
      const drawStart = dayStarts[k];
      const drawEnd = (dayStarts[k + 1] != null ? dayStarts[k + 1] : n) - 1;
      const profile = previousDayProfile(bars, profileStart, profileEnd, tick, rowTicks, valueAreaPct);
      if (!profile) continue;
      const time1 = bars[drawStart].time;
      const time2 = bars[drawEnd].time;
      const levelColor = color.new('#808080', 30);
      lines.push(
        { time1, price1: profile.vah, time2, price2: profile.vah, color: levelColor, width: 2, style: 'dotted' },
        { time1, price1: profile.val, time2, price2: profile.val, color: levelColor, width: 2, style: 'dotted' },
        { time1, price1: profile.poc, time2, price2: profile.poc, color: color.new('#F23645', 15), width: 2, style: 'dotted' },
      );
    }
    if (lines.length > MAX_PROFILE_LINES) lines.splice(0, lines.length - MAX_PROFILE_LINES);
  }

  /* ── Normalized volume bubbles / labels / levels ───────────────────────── */
  const stdevVolume = toArray(ta.stdev(volumeSeries, 200));
  const background = String(backgroundColorOf(chart) || '#0F0F0F').toLowerCase();
  const foreground = foregroundColorOf(chart) || '#DBDBDB';
  const gradientLow = background === '#ffffff'
    ? color.new('#089981', 100)
    : 'rgba(18, 34, 18, 0.5)';
  const heatLowA = color.new('#00BCD4', 50);
  const heatLowB = color.new('#089981', 50);
  const heatMidA = color.new('#FFEB3B', 50);
  const heatMidB = color.new('#FF9800', 30);
  const heatHigh = '#D32626';

  function heatColor(value) {
    if (!Number.isFinite(value)) return 'transparent';
    if (!cfg.heatmap) return color.from_gradient(value, 0, 8, gradientLow, '#089981');
    if (value < 1) return color.from_gradient(value, 0, 1, heatLowA, heatLowB);
    if (value > 1 && value < 4) return color.from_gradient(value, 1, 4, heatMidA, heatMidB);
    if (value > 4) return color.from_gradient(value, 4, 8, heatMidB, heatHigh);
    return 'transparent';
  }

  /** @type {Array<{ time: number; position: string; price: number; shape: string; color: string; size: string }>} */
  const markers = [];
  /** @type {Array<{ time: number; price: number; text: string; color: string; textColor: string; style: string }>} */
  const volumeLabels = [];
  const significantLines = [];
  const threshold = cfg.threshold;
  const bubbles = cfg.bubbles;
  const sourceValues = bars.map((bar) => (bar.high + bar.low) / 2);

  for (let i = 0; i < n; i++) {
    const norm = stdevVolume[i] > 0 ? volumeValues[i] / stdevVolume[i] : NaN;
    if (!Number.isFinite(norm)) continue;
    const paint = heatColor(norm);
    const source = sourceValues[i];
    if (bubbles) {
      let size = null;
      if (norm > 0 && norm < threshold) size = 'tiny';
      else if (norm > threshold && norm < 3) size = 'small';
      else if (norm > threshold + 2 && norm < 4) size = 'normal';
      else if (norm > threshold + 3 && norm < 6) size = 'large';
      if (size) markers.push({ time: bars[i].time, position: 'atPriceMiddle', price: source, shape: 'circle', color: paint, size });
    }
    const major = norm > 6;
    if (major && bubbles) {
      markers.push({ time: bars[i].time, position: 'atPriceMiddle', price: source, shape: 'circle', color: paint, size: 'huge' });
    }
    if (major && (cfg.showLevels || bubbles)) {
      volumeLabels.push({
        time: bubbles ? bars[i].time : bars[n - 1].time,
        price: source,
        text: formatVolume(volumeValues[i]),
        color: '#00000000',
        textColor: foreground,
        style: bubbles ? 'label_center' : 'label_left',
      });
    }
    if (major && cfg.showLevels) {
      significantLines.push({
        time1: bars[i].time,
        price1: source,
        time2: bars[n - 1].time,
        price2: source,
        color: paint,
        width: 2,
        style: 'solid',
      });
    }
  }

  const levelsQty = Math.max(1, Math.round(cfg.levelsQty));
  if (significantLines.length > levelsQty) significantLines.splice(0, significantLines.length - levelsQty);
  if (!bubbles && volumeLabels.length > levelsQty) {
    volumeLabels.splice(0, volumeLabels.length - levelsQty);
  }
  lines.push(...significantLines);
  labels.push(...volumeLabels);
  if (lines.length > MAX_PROFILE_LINES) lines.splice(0, lines.length - MAX_PROFILE_LINES);
  if (labels.length > 500) labels.splice(0, labels.length - 500);

  let cumulativeVolume = 0;
  for (let i = 0; i < n; i++) cumulativeVolume += Number.isFinite(volumeValues[i]) ? volumeValues[i] : 0;
  if (cumulativeVolume <= 0) {
    labels.push({
      time: bars[n - 1].time,
      price: sourceValues[n - 1],
      text: 'No Volume Data Provided\n Use other Symbol',
      color: '#00000000',
      textColor: foreground,
      style: 'label_left',
    });
  }

  return {
    metadata: { title: metadata.title, shorttitle: metadata.shortTitle, overlay: metadata.overlay },
    plots,
    fills,
    visibility,
    labels,
    boxes,
    lines,
    markers,
  };
}

export const MyIndicator = {
  id: 'my_indicator',
  group: 'custom',
  name: metadata.title,
  shortName: metadata.shortTitle,
  category: 'Volume',
  overlay: true,
  metadata,
  defaultInputs,
  inputConfig,
  plotConfig,
  calculate,
};
