'use client';

import {useQuery} from '@tanstack/react-query';
import {useMemo} from 'react';
import {api} from '@/lib/api';
import {formatPrice} from '@/lib/format';

/**
 * Unlock curve for a vesting schedule.
 *
 * Points come from the contract's own `vestedAt`, sampled by the API, rather than being recomputed
 * in the browser. Reimplementing the vesting maths here would eventually disagree with the contract
 * and draw a chart that promises tokens the contract will not pay.
 *
 * Drawn as inline SVG rather than pulling in a charting library: it is one polyline and two axes,
 * and a chart library would be a larger dependency than the whole page.
 */
export function UnlockCurve({scheduleId}: {scheduleId: string}) {
  const {data, isLoading} = useQuery({
    queryKey: ['vestingCurve', scheduleId],
    queryFn: () => api.vestingCurve(scheduleId),
  });

  const geometry = useMemo(() => {
    if (!data || data.points.length === 0) return null;

    const width = 600;
    const height = 180;
    const padding = {top: 8, right: 8, bottom: 24, left: 8};

    const total = BigInt(data.total);
    if (total === 0n) return null;

    const firstTime = data.points[0]!.timestamp;
    const lastTime = data.points[data.points.length - 1]!.timestamp;
    const span = Math.max(1, lastTime - firstTime);

    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    const points = data.points.map((point) => {
      const x = padding.left + ((point.timestamp - firstTime) / span) * plotWidth;
      // Ratio in basis points keeps the division in bigint space, avoiding precision loss on
      // 18-decimal values before converting to a pixel coordinate.
      const ratioBps = Number((BigInt(point.vested) * 10_000n) / total);
      const y = padding.top + plotHeight - (ratioBps / 10_000) * plotHeight;
      return {x, y, ...point};
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const nowX =
      nowSeconds <= firstTime
        ? padding.left
        : nowSeconds >= lastTime
          ? padding.left + plotWidth
          : padding.left + ((nowSeconds - firstTime) / span) * plotWidth;

    return {
      width,
      height,
      padding,
      plotHeight,
      polyline: points.map((point) => `${point.x},${point.y}`).join(' '),
      area: `${padding.left},${padding.top + plotHeight} ${points
        .map((point) => `${point.x},${point.y}`)
        .join(' ')} ${padding.left + plotWidth},${padding.top + plotHeight}`,
      nowX,
      firstTime,
      lastTime,
      showNow: nowSeconds > firstTime && nowSeconds < lastTime,
    };
  }, [data]);

  if (isLoading) {
    return <div className="h-44 animate-pulse rounded-lg bg-neutral-900" />;
  }

  if (!geometry || !data) {
    return <p className="text-sm text-neutral-600">No curve available.</p>;
  }

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        className="w-full"
        role="img"
        aria-label="Token unlock curve over the vesting period"
      >
        <defs>
          <linearGradient id={`fill-${scheduleId}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(99 102 241)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(99 102 241)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines at 0, 25, 50, 75 and 100 percent. */}
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const y = geometry.padding.top + geometry.plotHeight * (1 - fraction);
          return (
            <line
              key={fraction}
              x1={geometry.padding.left}
              x2={geometry.width - geometry.padding.right}
              y1={y}
              y2={y}
              stroke="rgb(38 38 38)"
              strokeWidth="1"
            />
          );
        })}

        <polygon points={geometry.area} fill={`url(#fill-${scheduleId})`} />
        <polyline
          points={geometry.polyline}
          fill="none"
          stroke="rgb(129 140 248)"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {geometry.showNow && (
          <>
            <line
              x1={geometry.nowX}
              x2={geometry.nowX}
              y1={geometry.padding.top}
              y2={geometry.padding.top + geometry.plotHeight}
              stroke="rgb(251 191 36)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <text
              x={geometry.nowX + 4}
              y={geometry.padding.top + 10}
              fill="rgb(251 191 36)"
              fontSize="10"
            >
              now
            </text>
          </>
        )}
      </svg>

      <div className="flex justify-between text-xs text-neutral-600">
        <span>{new Date(geometry.firstTime * 1000).toLocaleDateString()}</span>
        <span>{formatPrice(data.total)} total</span>
        <span>{new Date(geometry.lastTime * 1000).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
