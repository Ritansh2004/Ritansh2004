import fs from 'node:fs';
import path from 'node:path';

const USERNAME = process.env.GITHUB_USERNAME || 'Ritansh2004';
const TOKEN = process.env.GITHUB_TOKEN;
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'dist';

const GRAPHQL_QUERY = `
  query GrowingSnakeCalendar($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            firstDay
            contributionDays {
              date
              weekday
              contributionCount
              contributionLevel
            }
          }
        }
      }
    }
  }
`;

const THEMES = {
  dark: {
    background: '#0D1117',
    text: '#C9D1D9',
    muted: '#8B949E',
    empty: '#161B22',
    levels: ['#161B22', '#0E4429', '#006D32', '#26A641', '#39D353'],
    snakeStart: '#22D3EE',
    snakeEnd: '#8B5CF6',
    head: '#F97316',
    eye: '#0D1117',
  },
  light: {
    background: '#FFFFFF',
    text: '#24292F',
    muted: '#57606A',
    empty: '#EBEDF0',
    levels: ['#EBEDF0', '#9BE9A8', '#40C463', '#30A14E', '#216E39'],
    snakeStart: '#0891B2',
    snakeEnd: '#6D28D9',
    head: '#EA580C',
    eye: '#FFFFFF',
  },
};

const GRID = {
  left: 42,
  top: 62,
  cell: 10,
  segment: 10.8,
  step: 14,
  rowCount: 7,
  initialLength: 3,
  frameSeconds: 0.22,
  dotFadeSeconds: 0.12,
};

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function levelIndex(level, count) {
  const byLevel = {
    NONE: 0,
    FIRST_QUARTILE: 1,
    SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3,
    FOURTH_QUARTILE: 4,
  };
  if (Object.hasOwn(byLevel, level)) return byLevel[level];
  return count > 0 ? 1 : 0;
}

export function normalizeCalendar(calendar) {
  if (!calendar || !Array.isArray(calendar.weeks) || calendar.weeks.length === 0) {
    throw new Error('GitHub returned an empty contribution calendar.');
  }

  return calendar.weeks.map((week) => {
    const daysByWeekday = new Map(
      (week.contributionDays || []).map((day) => [Number(day.weekday), day]),
    );

    return Array.from({ length: GRID.rowCount }, (_, weekday) => {
      const day = daysByWeekday.get(weekday);
      if (!day) {
        return {
          date: '',
          contributionCount: 0,
          contributionLevel: 'NONE',
        };
      }

      return {
        date: day.date || '',
        contributionCount: Math.max(0, Number(day.contributionCount) || 0),
        contributionLevel: day.contributionLevel || 'NONE',
      };
    });
  });
}

function cellKey(column, weekday) {
  return `${column}:${weekday}`;
}

function sameCell(a, b) {
  return a.column === b.column && a.weekday === b.weekday;
}

function manhattan(a, b) {
  return Math.abs(a.column - b.column) + Math.abs(a.weekday - b.weekday);
}

function makeManhattanPath(from, to, horizontalFirst) {
  const result = [{ ...from }];
  let column = from.column;
  let weekday = from.weekday;

  const moveColumns = () => {
    const direction = Math.sign(to.column - column);
    while (column !== to.column) {
      column += direction;
      result.push({ column, weekday });
    }
  };
  const moveRows = () => {
    const direction = Math.sign(to.weekday - weekday);
    while (weekday !== to.weekday) {
      weekday += direction;
      result.push({ column, weekday });
    }
  };

  if (horizontalFirst) {
    moveColumns();
    moveRows();
  } else {
    moveRows();
    moveColumns();
  }
  return result;
}

function countRemainingDotsOnPath(path, remaining) {
  let count = 0;
  const seen = new Set();
  for (const cell of path) {
    const key = cellKey(cell.column, cell.weekday);
    if (remaining.has(key) && !seen.has(key)) {
      seen.add(key);
      count += 1;
    }
  }
  return count;
}

function chooseStartCandidates(weeks) {
  const candidates = [];
  for (let column = 0; column < weeks.length; column += 1) {
    for (let weekday = 0; weekday < GRID.rowCount; weekday += 1) {
      if (weeks[column][weekday].contributionCount === 0) {
        candidates.push({ column, weekday });
      }
    }
  }
  return candidates;
}

function padClosedRoute(route, minimumSteps, width) {
  let result = route.map((cell) => ({ ...cell }));
  let required = Math.max(0, minimumSteps - result.length);
  // A closed orthogonal grid route has an even number of steps.
  if (required % 2 === 1) required += 1;

  while (required >= 2) {
    const routeKeys = new Set(result.map((cell) => cellKey(cell.column, cell.weekday)));
    const usedDetourKeys = new Set();
    const expanded = [result[0]];
    let added = 0;

    for (let i = 0; i < result.length && added < required; i += 1) {
      const from = result[i];
      const to = result[(i + 1) % result.length];
      const candidates = [];

      if (from.column === to.column) {
        for (const offset of [-1, 1]) {
          candidates.push([
            { column: from.column + offset, weekday: from.weekday },
            { column: to.column + offset, weekday: to.weekday },
          ]);
        }
      } else if (from.weekday === to.weekday) {
        for (const offset of [-1, 1]) {
          candidates.push([
            { column: from.column, weekday: from.weekday + offset },
            { column: to.column, weekday: to.weekday + offset },
          ]);
        }
      }

      let detour = null;
      for (const pair of candidates) {
        const inBounds = pair.every((cell) =>
          cell.column >= 0 && cell.column < width &&
          cell.weekday >= 0 && cell.weekday < GRID.rowCount,
        );
        if (!inBounds) continue;
        const keys = pair.map((cell) => cellKey(cell.column, cell.weekday));
        if (keys.some((key) => routeKeys.has(key) || usedDetourKeys.has(key))) continue;
        detour = pair;
        keys.forEach((key) => usedDetourKeys.add(key));
        break;
      }

      if (detour) {
        expanded.push(detour[0], detour[1]);
        added += 2;
      }

      // Do not repeat the cycle's first cell; SVG Z supplies this last edge.
      if (i < result.length - 1) expanded.push(to);
    }

    if (added === 0) break;
    result = expanded;
    required -= added;
  }

  return result;
}

function routeFromStart(weeks, activeDots, start) {
  const remaining = new Map(activeDots.map((day) => [
    cellKey(day.column, day.weekday), { ...day },
  ]));
  const route = [{ ...start }];
  const eaten = [];
  let current = { ...start };

  // If every calendar square is active, the fallback start may itself be a
  // contribution dot. Collect it at the initial frame to avoid a zero-step loop.
  const startingKey = cellKey(start.column, start.weekday);
  const startingDay = remaining.get(startingKey);
  if (startingDay) {
    eaten.push({ ...startingDay, step: 0 });
    remaining.delete(startingKey);
  }

  const addVisitedCell = (cell) => {
    route.push({ ...cell });
    current = { ...cell };
    const key = cellKey(cell.column, cell.weekday);
    const day = remaining.get(key);
    if (day) {
      eaten.push({ ...day, step: route.length - 1 });
      remaining.delete(key);
    }
  };

  // Repeatedly target the nearest remaining contribution dot. The route
  // only crosses the shortest row/column path between targets.
  while (remaining.size > 0) {
    let target = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of remaining.values()) {
      const distance = manhattan(current, candidate);
      if (
        distance < bestDistance ||
        (distance === bestDistance && target && String(candidate.date).localeCompare(String(target.date)) < 0)
      ) {
        target = candidate;
        bestDistance = distance;
      }
    }

    const horizontalPath = makeManhattanPath(current, target, true);
    const verticalPath = makeManhattanPath(current, target, false);
    const horizontalScore = countRemainingDotsOnPath(horizontalPath, remaining);
    const verticalScore = countRemainingDotsOnPath(verticalPath, remaining);
    const chosenPath = verticalScore > horizontalScore ? verticalPath : horizontalPath;

    for (const cell of chosenPath.slice(1)) addVisitedCell(cell);
  }

  // Close the tour with a shortest path. This is only a connector from the
  // final dot back to the start; it does not sweep the calendar row by row.
  if (sameCell(current, start)) {
    if (route.length > 1) route.pop();
  } else {
    const closePath = makeManhattanPath(current, start, true);
    for (const cell of closePath.slice(1, -1)) route.push({ ...cell });
  }

  const minimumLength = GRID.initialLength + eaten.length;
  const paddedRoute = padClosedRoute(route, minimumLength, weeks.length);

  // Padding may insert a harmless detour before a target. Recalculate the
  // exact first-touch step for every contribution dot on the final route.
  const activeByKey = new Map(activeDots.map((day) => [
    cellKey(day.column, day.weekday), { ...day },
  ]));
  const finalEaten = [];
  for (let step = 0; step < paddedRoute.length; step += 1) {
    const cell = paddedRoute[step];
    const key = cellKey(cell.column, cell.weekday);
    const day = activeByKey.get(key);
    if (day) {
      finalEaten.push({ ...day, step });
      activeByKey.delete(key);
    }
  }

  return { route: paddedRoute, eaten: finalEaten, start: { ...start } };
}

/**
 * Build a short dot-to-dot tour. Several empty starting squares are evaluated,
 * and the shortest nearest-neighbour tour is selected to avoid a long sweep
 * back across the full chart at the end of the animation cycle.
 */
export function buildRoute(weeks) {
  const activeDots = [];
  for (let column = 0; column < weeks.length; column += 1) {
    for (let weekday = 0; weekday < GRID.rowCount; weekday += 1) {
      const day = weeks[column][weekday];
      if (day.contributionCount > 0) {
        activeDots.push({
          column,
          weekday,
          date: day.date,
          contributionCount: day.contributionCount,
          contributionLevel: day.contributionLevel,
        });
      }
    }
  }

  const candidates = chooseStartCandidates(weeks);
  if (activeDots.length === 0) {
    const start = candidates[0] || { column: 0, weekday: 0 };
    const right = Math.min(weeks.length - 1, start.column + 1);
    const down = Math.min(GRID.rowCount - 1, start.weekday + 1);
    return {
      route: [start, { column: right, weekday: start.weekday }, { column: right, weekday: down }, { column: start.column, weekday: down }],
      eaten: [],
      start,
    };
  }
  if (candidates.length === 0) {
    const fallback = { column: 0, weekday: 0 };
    return routeFromStart(weeks, activeDots, fallback);
  }

  let best = null;
  for (const start of candidates) {
    const candidate = routeFromStart(weeks, activeDots, start);
    if (!best || candidate.route.length < best.route.length) {
      best = candidate;
    }
  }

  if (best) return best;

  // Empty-calendar fallback: a small rectangle keeps the SVG path animatable.
  const start = candidates[0] || { column: 0, weekday: 0 };
  const right = Math.min(weeks.length - 1, start.column + 1);
  const down = Math.min(GRID.rowCount - 1, start.weekday + 1);
  return {
    route: [start, { column: right, weekday: start.weekday }, { column: right, weekday: down }, { column: start.column, weekday: down }],
    eaten: [],
    start,
  };
}

function contributionColor(day, theme) {
  const index = levelIndex(day.contributionLevel, day.contributionCount);
  return theme.levels[index] || theme.empty;
}

function coordinates(column, weekday) {
  return {
    x: GRID.left + column * GRID.step,
    y: GRID.top + weekday * GRID.step,
  };
}

function monthLabels(weeks) {
  const labels = [];
  for (let column = 0; column < weeks.length; column += 1) {
    const firstOfMonth = weeks[column].find((day) => day.date && day.date.endsWith('-01'));
    if (firstOfMonth) {
      const date = new Date(`${firstOfMonth.date}T00:00:00Z`);
      const month = new Intl.DateTimeFormat('en', {
        month: 'short',
        timeZone: 'UTC',
      }).format(date);
      labels.push({ column, month });
    }
  }
  return labels;
}

function animateOpacity(startFraction, endFraction, from, to, duration) {
  const startValue = Math.max(0, Math.min(0.999, startFraction));
  const endValue = Math.max(startValue + 0.000001, Math.min(0.999999, endFraction));
  if (startValue === 0) {
    return `<animate attributeName="opacity" values="${from};${to};${to}" keyTimes="0;${endValue.toFixed(6)};1" dur="${duration.toFixed(3)}s" repeatCount="indefinite" calcMode="linear" />`;
  }
  return `<animate attributeName="opacity" values="${from};${from};${to};${to}" keyTimes="0;${startValue.toFixed(6)};${endValue.toFixed(6)};1" dur="${duration.toFixed(3)}s" repeatCount="indefinite" calcMode="linear" />`;
}

export function buildSvg(calendar, themeName = 'dark') {
  const theme = THEMES[themeName];
  if (!theme) throw new Error(`Unknown theme: ${themeName}`);

  const weeks = normalizeCalendar(calendar);
  const { route, eaten } = buildRoute(weeks);
  const total = Number(calendar.totalContributions) || 0;
  const activeDays = eaten.length;
  const maxLength = GRID.initialLength + activeDays;
  const cycleSteps = route.length;
  const stepSeconds = GRID.frameSeconds;
  const cycleDuration = cycleSteps * stepSeconds;
  const durationText = cycleDuration.toFixed(3);

  const width = GRID.left + (weeks.length - 1) * GRID.step + GRID.cell + 24;
  const height = GRID.top + (GRID.rowCount - 1) * GRID.step + GRID.cell + 43;
  const parts = [];

  const routeD = route.map((cell, index) => {
    const point = coordinates(cell.column, cell.weekday);
    return `${index === 0 ? 'M' : 'L'}${(point.x + GRID.cell / 2).toFixed(2)},${(point.y + GRID.cell / 2).toFixed(2)}`;
  }).join(' ') + ' Z';

  const eatenByKey = new Map(
    eaten.map((item, index) => [cellKey(item.column, item.weekday), { ...item, order: index + 1 }]),
  );

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`);
  parts.push(`<title id="title">Ritansh2004 contribution-seeking growing snake</title>`);
  parts.push(`<desc id="description">The snake searches for the nearest contribution day, moves directly to its dot, eats it so the dot disappears, and grows one segment. It does not scan every calendar square.</desc>`);
  parts.push(`<defs>`);
  parts.push(`<linearGradient id="snakeBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${theme.snakeStart}"/><stop offset="100%" stop-color="${theme.snakeEnd}"/></linearGradient>`);
  parts.push(`<filter id="headGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
  parts.push(`<path id="snakeRoute" d="${routeD}" fill="none"/>`);
  parts.push(`</defs>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="${theme.background}"/>`);
  parts.push(`<text x="${GRID.left}" y="23" fill="${theme.text}" font-family="Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="1.2">GITHUB CONTRIBUTION ACTIVITY</text>`);
  parts.push(`<text x="${width - 16}" y="23" text-anchor="end" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="9">${total.toLocaleString('en-US')} contributions</text>`);

  for (const label of monthLabels(weeks)) {
    const x = GRID.left + label.column * GRID.step;
    parts.push(`<text x="${x}" y="47" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="9">${label.month}</text>`);
  }

  for (const [weekday, label] of [[0, 'Sun'], [2, 'Tue'], [4, 'Thu'], [6, 'Sat']]) {
    const y = GRID.top + weekday * GRID.step + GRID.cell - 1;
    parts.push(`<text x="7" y="${y}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="8">${label}</text>`);
  }

  // Draw the calendar squares. Active contribution dots fade out precisely
  // when the snake head reaches their coordinates, then reappear on the next
  // animation cycle so the SVG can replay continuously.
  for (let column = 0; column < weeks.length; column += 1) {
    for (let weekday = 0; weekday < GRID.rowCount; weekday += 1) {
      const day = weeks[column][weekday];
      const point = coordinates(column, weekday);
      const title = day.date
        ? `${day.date}: ${day.contributionCount} contribution(s)`
        : 'No contribution data';
      const eatenDay = eatenByKey.get(cellKey(column, weekday));
      parts.push(`<rect x="${point.x}" y="${point.y}" width="${GRID.cell}" height="${GRID.cell}" rx="2" fill="${theme.empty}"/>`);
      if (day.contributionCount > 0) {
        parts.push(`<rect x="${point.x}" y="${point.y}" width="${GRID.cell}" height="${GRID.cell}" rx="2" fill="${contributionColor(day, theme)}"><title>${xmlEscape(title)}</title>`);
        if (eatenDay) {
          const eatTime = eatenDay.step * stepSeconds;
          const fadeEnd = Math.min(cycleDuration, eatTime + GRID.dotFadeSeconds);
          const startFraction = eatTime / cycleDuration;
          const endFraction = fadeEnd / cycleDuration;
          parts.push(animateOpacity(startFraction, endFraction, '1', '0', cycleDuration));
        }
        parts.push(`</rect>`);
      }
    }
  }

  // Body segments are placed one route-step behind the head. A new segment
  // becomes visible when a contribution dot is eaten; it appears at the tail.
  for (let segmentIndex = maxLength - 1; segmentIndex >= 1; segmentIndex -= 1) {
    const segment = `<rect x="${-GRID.segment / 2}" y="${-GRID.segment / 2}" width="${GRID.segment}" height="${GRID.segment}" rx="3.4" fill="url(#snakeBody)">`;
    parts.push(segment);
    parts.push(`<animateMotion dur="${durationText}s" begin="-${(segmentIndex * stepSeconds).toFixed(3)}s" repeatCount="indefinite" rotate="0"><mpath href="#snakeRoute" xlink:href="#snakeRoute"/></animateMotion>`);

    if (segmentIndex < GRID.initialLength) {
      parts.push(`<animate attributeName="opacity" values="1" dur="${durationText}s" repeatCount="indefinite"/>`);
    } else {
      const growthIndex = segmentIndex - GRID.initialLength;
      const growthEvent = eaten[growthIndex];
      if (growthEvent) {
        const birthTime = growthEvent.step * stepSeconds;
        const fadeEnd = Math.min(cycleDuration, birthTime + GRID.dotFadeSeconds);
        const startFraction = birthTime / cycleDuration;
        const endFraction = fadeEnd / cycleDuration;
        parts.push(animateOpacity(startFraction, endFraction, '0', '1', cycleDuration));
      }
    }
    parts.push(`</rect>`);
  }

  // Head starts in an empty square and travels to the nearest active dot.
  parts.push(`<g><animateMotion dur="${durationText}s" repeatCount="indefinite" rotate="0"><mpath href="#snakeRoute" xlink:href="#snakeRoute"/></animateMotion><circle cx="0" cy="0" r="5.4" fill="${theme.head}" stroke="${theme.background}" stroke-width="1.2" filter="url(#headGlow)"/><circle cx="-1.6" cy="-1.1" r="0.85" fill="${theme.eye}"/><circle cx="1.6" cy="-1.1" r="0.85" fill="${theme.eye}"/></g>`);

  parts.push(`<text x="${GRID.left}" y="${height - 11}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="8.5">TARGETS: ${activeDays} CONTRIBUTION DAYS</text>`);
  parts.push(`<text x="${width - 16}" y="${height - 11}" text-anchor="end" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="8.5">MAX LENGTH: ${maxLength} SEGMENTS</text>`);
  parts.push(`</svg>`);

  return parts.join('\n');
}

async function fetchCalendar(username, token) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Ritansh2004-growing-snake',
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: { login: username },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${payload.errors.map((error) => error.message).join('; ')}`);
  }

  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) {
    throw new Error(`Could not find a contribution calendar for GitHub user "${username}". Check the username.`);
  }
  return calendar;
}

async function main() {
  if (!TOKEN) {
    throw new Error('GITHUB_TOKEN is missing. Run this script from the included GitHub Actions workflow.');
  }

  const calendar = await fetchCalendar(USERNAME, TOKEN);
  const weeks = normalizeCalendar(calendar);
  const { route, eaten } = buildRoute(weeks);
  const maxLength = GRID.initialLength + eaten.length;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'growing-snake.svg'), buildSvg(calendar, 'light'), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'growing-snake-dark.svg'), buildSvg(calendar, 'dark'), 'utf8');

  console.log(`Generated contribution-seeking snake SVGs for ${USERNAME}.`);
  console.log(`Calendar: ${weeks.length} weeks / ${weeks.length * GRID.rowCount} cells.`);
  console.log(`Contribution total: ${Number(calendar.totalContributions) || 0}.`);
  console.log(`Contribution days collected: ${eaten.length}.`);
  console.log(`Route steps: ${route.length} (the snake does not traverse every calendar square).`);
  console.log(`Maximum snake length: ${maxLength} segments.`);
}

const isMainModule = process.argv[1]
  && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
