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
  },
};

const GRID = {
  left: 42,
  top: 62,
  cell: 10,
  segment: 10.5,
  step: 14,
  rowCount: 7,
  initialLength: 3,
  frameSeconds: 0.16,
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

function normalizeCalendar(calendar) {
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

function getGridWidth(weekCount) {
  // The grid must have an even number of columns for this Hamiltonian cycle.
  // Add the smallest number of neutral columns needed to make it even.
  return weekCount + (weekCount % 2 === 1 ? 1 : 2);
}

function makePath(weeks) {
  const pathCells = [];
  const gridWidth = getGridWidth(weeks.length);
  const emptyDay = {
    date: '',
    contributionCount: 0,
    contributionLevel: 'NONE',
  };

  const addCell = (column, weekday) => {
    const day = column < weeks.length ? weeks[column][weekday] : emptyDay;
    pathCells.push({ column, weekday, ...day });
  };

  // Hamiltonian cycle for a 7 x even-width grid:
  // 1) traverse column 0 from top to bottom;
  // 2) snake through rows 1..6 of the remaining columns;
  // 3) return across row 0 to the starting cell.
  // The final edge back to (0, 0) is adjacent, so the snake can loop forever
  // without jumping across the calendar or colliding with its own body.
  for (let weekday = 0; weekday < GRID.rowCount; weekday += 1) {
    addCell(0, weekday);
  }

  for (let column = 1; column < gridWidth; column += 1) {
    const weekdays = column % 2 === 1
      ? [6, 5, 4, 3, 2, 1]
      : [1, 2, 3, 4, 5, 6];
    for (const weekday of weekdays) addCell(column, weekday);
  }

  for (let column = gridWidth - 1; column >= 1; column -= 1) {
    addCell(column, 0);
  }

  return pathCells;
}

function makeFrames(pathCells) {
  const initialHead = Math.min(GRID.initialLength - 1, pathCells.length - 1);
  let length = initialHead + 1;
  const frames = [];

  for (let headIndex = initialHead; headIndex < pathCells.length; headIndex += 1) {
    // Every non-empty contribution day adds one segment at the tail.
    if (headIndex > initialHead && pathCells[headIndex].contributionCount > 0) {
      length = Math.min(pathCells.length, length + 1);
    }
    frames.push({ headIndex, length });
  }

  return frames;
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

function animationAttributes(attribute, values, keyTimes, duration, calcMode = 'linear') {
  return `<animate attributeName="${attribute}" values="${values.join(';')}" keyTimes="${keyTimes}" dur="${duration}s" repeatCount="indefinite" calcMode="${calcMode}" />`;
}

export function buildSvg(calendar, themeName = 'dark') {
  const theme = THEMES[themeName];
  if (!theme) throw new Error(`Unknown theme: ${themeName}`);

  const weeks = normalizeCalendar(calendar);
  const route = makePath(weeks);
  const frames = makeFrames(route);
  const frameCount = frames.length;
  const total = Number(calendar.totalContributions) || 0;
  const maxLength = Math.max(...frames.map((frame) => frame.length));
  const routeDuration = (route.length * GRID.frameSeconds).toFixed(2);
  const cycleDuration = route.length * GRID.frameSeconds;
  const startHead = Math.min(GRID.initialLength - 1, route.length - 1);

  const gridWidth = getGridWidth(weeks.length);
  const width = GRID.left + (gridWidth - 1) * GRID.step + GRID.cell + 24;
  const height = GRID.top + (GRID.rowCount - 1) * GRID.step + GRID.cell + 43;
  const parts = [];

  const routeD = route.map((cell, index) => {
    const point = coordinates(cell.column, cell.weekday);
    return `${index === 0 ? 'M' : 'L'}${(point.x + GRID.cell / 2).toFixed(2)},${(point.y + GRID.cell / 2).toFixed(2)}`;
  }).join(' ') + ' Z';

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`);
  parts.push(`<title id="title">Ritansh2004 growing GitHub contribution snake</title>`);
  parts.push(`<desc id="description">An animated snake follows a safe loop through the contribution calendar. It grows by one segment every time it reaches a day with at least one contribution.</desc>`);
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

  const dayLabels = [[0, 'Sun'], [2, 'Tue'], [4, 'Thu'], [6, 'Sat']];
  for (const [weekday, label] of dayLabels) {
    const y = GRID.top + weekday * GRID.step + GRID.cell - 1;
    parts.push(`<text x="7" y="${y}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="8">${label}</text>`);
  }

  // Draw all real contribution cells.
  for (let column = 0; column < weeks.length; column += 1) {
    for (let weekday = 0; weekday < GRID.rowCount; weekday += 1) {
      const day = weeks[column][weekday];
      const point = coordinates(column, weekday);
      const title = day.date
        ? `${day.date}: ${day.contributionCount} contribution(s)`
        : 'No contribution data';
      parts.push(`<rect x="${point.x}" y="${point.y}" width="${GRID.cell}" height="${GRID.cell}" rx="2" fill="${contributionColor(day, theme)}"><title>${xmlEscape(title)}</title></rect>`);
    }
  }

  // Add neutral columns used only to close the route. They contain no data.
  for (let column = weeks.length; column < gridWidth; column += 1) {
    for (let weekday = 0; weekday < GRID.rowCount; weekday += 1) {
      const point = coordinates(column, weekday);
      parts.push(`<rect x="${point.x}" y="${point.y}" width="${GRID.cell}" height="${GRID.cell}" rx="2" fill="${theme.empty}" opacity="0.48"/>`);
    }
  }

  // Each segment follows the same closed route with a one-step delay per
  // segment. A segment becomes visible only when a contribution makes the
  // snake grow, which adds it at the tail instead of at the head.
  const stepSeconds = GRID.frameSeconds;
  for (let segmentIndex = maxLength - 1; segmentIndex >= 1; segmentIndex -= 1) {
    const birthFrame = segmentIndex < GRID.initialLength
      ? 0
      : frames.findIndex((frame) => frame.length > segmentIndex);
    if (birthFrame < 0) continue;

    const opacity = segmentIndex < GRID.initialLength ? '1' : '0';
    const beginSeconds = ((segmentIndex - startHead) * stepSeconds).toFixed(2);
    const segment = `<rect x="${-GRID.segment / 2}" y="${-GRID.segment / 2}" width="${GRID.segment}" height="${GRID.segment}" rx="3.4" fill="url(#snakeBody)" opacity="${opacity}"><animateMotion dur="${routeDuration}s" begin="${beginSeconds}s" repeatCount="indefinite" rotate="0"><mpath href="#snakeRoute" xlink:href="#snakeRoute"/></animateMotion>`;
    parts.push(segment);

    if (segmentIndex >= GRID.initialLength) {
      const birthTime = birthFrame * stepSeconds;
      const birthKey = Math.min(0.999999, birthTime / cycleDuration).toFixed(6);
      parts.push(`<animate attributeName="opacity" values="0;1;1" keyTimes="0;${birthKey};1" dur="${routeDuration}s" repeatCount="indefinite" calcMode="discrete"/>`);
    }

    parts.push(`</rect>`);
  }

  const headBegin = (-startHead * stepSeconds).toFixed(2);
  parts.push(`<circle cx="0" cy="0" r="5.4" fill="${theme.head}" stroke="${theme.background}" stroke-width="1.2" filter="url(#headGlow)"><animateMotion dur="${routeDuration}s" begin="${headBegin}s" repeatCount="indefinite" rotate="0"><mpath href="#snakeRoute" xlink:href="#snakeRoute"/></animateMotion></circle>`);

  parts.push(`<text x="${GRID.left}" y="${height - 11}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="8.5">SNAKE GROWS +1 SEGMENT PER ACTIVE CONTRIBUTION DAY</text>`);
  parts.push(`<text x="${width - 16}" y="${height - 11}" text-anchor="end" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="8.5">FINAL LENGTH: ${maxLength}</text>`);
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
  const pathCells = makePath(weeks);
  const frames = makeFrames(pathCells);
  const finalLength = frames.at(-1)?.length ?? 0;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'growing-snake.svg'), buildSvg(calendar, 'light'), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'growing-snake-dark.svg'), buildSvg(calendar, 'dark'), 'utf8');

  console.log(`Generated light and dark growing snake SVGs for ${USERNAME}.`);
  console.log(`Calendar: ${weeks.length} weeks / ${pathCells.length} cells.`);
  console.log(`Contribution total: ${Number(calendar.totalContributions) || 0}.`);
  console.log(`Final snake length: ${finalLength} segments.`);
}

const isMainModule = process.argv[1]
  && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
