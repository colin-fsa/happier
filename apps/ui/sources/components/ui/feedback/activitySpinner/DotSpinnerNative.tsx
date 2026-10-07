import * as React from 'react';
import { Animated, type ViewProps } from 'react-native';

import { useDotSpinnerBreathClock, useDotSpinnerCycleClock } from './dotSpinnerClock';
import {
    DOT_SPINNER_STILL_OPACITY,
    getDotSpinnerFrames,
    readDotSeries,
    unwrapHueSeries,
    type DotSpinnerFrames,
    type DotSpinnerInk,
} from './dotSpinnerFrames';
import { type DotSpinnerStyleId, type DotSpinnerTiming, type SpinnerDot } from './dotSpinnerStyles';
import type { DotSpinnerMotion } from './dotSpinnerMotion';

const BREATH_LOW_OPACITY = 0.45;

/**
 * The accent gradient repeated over hue positions −3…3, so an unwrapped hue series (which drifts
 * past 0 and 1 instead of jumping back) always lands on it. Stop `k` sits at `k / 3`.
 */
const HUE_STOPS = Array.from({ length: 19 }, (_, i) => i - 9);

type DotDrive = Readonly<{
    opacity: Animated.AnimatedInterpolation<number> | number;
    color: Animated.AnimatedInterpolation<string> | string;
}>;

function frameInputRange(frameCount: number): number[] {
    return Array.from({ length: frameCount + 1 }, (_, frame) => frame / frameCount);
}

function auroraGradient(aurora: readonly [string, string, string]) {
    return {
        inputRange: HUE_STOPS.map((k) => k / 3),
        outputRange: HUE_STOPS.map((k) => aurora[((k % 3) + 3) % 3]!),
    };
}

/**
 * How each dot is driven. Animated dots interpolate the shared cycle clock over the frame table,
 * closed back onto frame 0 so the loop's wrap is seamless; colour goes clock → unwrapped hue →
 * accent gradient, all on the native driver (`backgroundColor` is in React Native's native-animated
 * colour allow-list). Still dots hold the full chosen mark and their first frame's colour.
 */
function driveDots(frames: DotSpinnerFrames, ink: DotSpinnerInk, clock: Animated.Value, still: boolean): readonly DotDrive[] {
    const inputRange = frameInputRange(frames.frameCount);
    return frames.dots.map((_, index) => {
        let opacity: DotDrive['opacity'] = DOT_SPINNER_STILL_OPACITY;
        if (!still) {
            const series = readDotSeries(frames, frames.opacity, index);
            opacity = clock.interpolate({ inputRange, outputRange: [...series, series[0]!] });
        }
        if ('color' in ink || !frames.hue) {
            return { opacity, color: 'color' in ink ? ink.color : ink.aurora[0] };
        }
        const hue = unwrapHueSeries(readDotSeries(frames, frames.hue, index));
        const gradient = auroraGradient(ink.aurora);
        if (still) {
            // A one-off JS interpolation blends the two accents exactly without parsing either colour.
            return { opacity, color: new Animated.Value(hue[0]!).interpolate(gradient) };
        }
        const closingHue = hue[0]! - Math.round(hue[0]! - hue[hue.length - 1]!);
        return { opacity, color: clock.interpolate({ inputRange, outputRange: [...hue, closingHue] }).interpolate(gradient) };
    });
}

/**
 * The native dots. Every dot is an `Animated.View` driven by the style's shared cycle clock, so the
 * whole animation runs on the native driver with no per-frame JavaScript, and all spinners of a
 * style step together. Still and breathing poses hold no cycle clock; a breath holds the one shared
 * breath clock. A hidden spinner keeps its box and draws nothing.
 */
export function DotSpinnerNative(props: Readonly<{
    styleId: DotSpinnerStyleId;
    timing: DotSpinnerTiming;
    size: number;
    ink: DotSpinnerInk;
    motion: DotSpinnerMotion;
    hidden: boolean;
    viewProps: ViewProps;
}>) {
    const { styleId, timing, size, ink, motion, hidden, viewProps } = props;
    const frames = getDotSpinnerFrames(styleId, timing);
    const animate = motion === 'animate' && !hidden;
    const breathe = motion === 'breathe' && !hidden;
    const clock = useDotSpinnerCycleClock(frames.cycleMs, animate);
    const breath = useDotSpinnerBreathClock(breathe);
    const drives = React.useMemo(() => driveDots(frames, ink, clock, !animate), [animate, clock, frames, ink]);
    const layerOpacity = React.useMemo(
        () => (breathe ? breath.interpolate({ inputRange: [0, 1], outputRange: [1, BREATH_LOW_OPACITY] }) : 1),
        [breath, breathe],
    );

    return (
        <Animated.View {...viewProps} style={[{ width: size, height: size, alignSelf: 'center', opacity: layerOpacity }, viewProps.style]}>
            {hidden ? null : frames.dots.map((dot, index) => (
                <NativeDot key={dot.id} dot={dot} size={size} drive={drives[index]!} />
            ))}
        </Animated.View>
    );
}

const NativeDot = React.memo(function NativeDot(props: Readonly<{ dot: SpinnerDot; size: number; drive: DotDrive }>) {
    const { dot, size, drive } = props;
    const pitch = size / 3;
    const diameter = size / 6;
    return (
        <Animated.View
            testID="activity-spinner-dot"
            style={{
                position: 'absolute',
                left: (dot.col + 0.5) * pitch - diameter / 2,
                top: (dot.row + 0.5) * pitch - diameter / 2,
                width: diameter,
                height: diameter,
                borderRadius: diameter / 2,
                backgroundColor: drive.color,
                opacity: drive.opacity,
            }}
        />
    );
});
