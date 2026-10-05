import React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import Yoga from 'yoga-layout';
import { lightTheme } from '@/theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dimensionsRef = vi.hoisted(() => ({ width: 1000, height: 800 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: dimensionsRef.width, height: dimensionsRef.height }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => Object.assign(accumulator, flattenStyle(entry)),
            {},
        );
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

async function layoutCells(screen: Screen, ids: readonly string[], width: number) {
    const grid = screen.findAll((node) => typeof node.type === 'string'
        && typeof flattenStyle(node.props.style).columnGap === 'number')[0];
    if (!grid) throw new Error('Missing rendered columns container');
    await act(async () => {
        grid.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height: 0 } } });
    });
    const gridStyle = flattenStyle(grid.props.style);
    const root = Yoga.Node.create();
    root.setWidth(width);
    root.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    root.setFlexWrap(Yoga.WRAP_WRAP);
    root.setAlignItems(Yoga.ALIGN_FLEX_START);
    root.setPadding(Yoga.EDGE_HORIZONTAL, Number(gridStyle.paddingHorizontal));
    root.setPadding(Yoga.EDGE_VERTICAL, Number(gridStyle.paddingVertical));
    root.setGap(Yoga.GUTTER_COLUMN, Number(gridStyle.columnGap));
    root.setGap(Yoga.GUTTER_ROW, Number(gridStyle.rowGap));
    try {
        for (const [index, id] of ids.entries()) {
            const style = flattenStyle(screen.findByTestId(id)?.parent?.props.style);
            const cell = Yoga.Node.create();
            cell.setHeight(60);
            cell.setMinWidth(0);
            if (typeof style.width === 'number' || style.width === '100%') cell.setWidth(style.width);
            if (typeof style.flexBasis === 'number' || style.flexBasis === '100%') cell.setFlexBasis(style.flexBasis);
            if (typeof style.flexGrow === 'number') cell.setFlexGrow(style.flexGrow);
            if (typeof style.flexShrink === 'number') cell.setFlexShrink(style.flexShrink);
            root.insertChild(cell, index);
        }
        root.calculateLayout(width, undefined, Yoga.DIRECTION_LTR);
        return ids.map((_, index) => root.getChild(index).getComputedLayout());
    } finally {
        root.freeRecursive();
    }
}

describe('ItemSection', () => {
    it('renders the caption as an uppercase eyebrow', async () => {
        dimensionsRef.width = 1000;
        dimensionsRef.height = 800;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');
        const { Text } = await import('@/components/ui/text/Text');

        const screen = await renderScreen(
            <ItemSection testID="usage" caption="Usage">
                <ItemGroupColumn>
                    <Text testID="cell">Body</Text>
                </ItemGroupColumn>
            </ItemSection>,
        );

        expect(screen.getTextContent()).toContain('Usage');
    });

    it('wraps eight usage meters into two readable columns and reflows when the card resizes', async () => {
        dimensionsRef.width = 1000;
        dimensionsRef.height = 800;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');

        const ids = Array.from({ length: 8 }, (_, index) => `cell-${index}`);
        const screen = await renderScreen(
            <ItemSection testID="usage" caption="Usage" columns={2} collapseBelow="medium">
                {ids.map((id) => <ItemGroupColumn key={id}><View testID={id} /></ItemGroupColumn>)}
            </ItemSection>,
        );

        for (const width of [836, 644]) {
            const cells = await layoutCells(screen, ids, width);
            expect(new Set(cells.map((cell) => cell.top)).size).toBe(4);
            for (let index = 0; index < cells.length; index += 2) {
                expect(cells[index]!.width).toBeCloseTo((width - 32 - 12) / 2, 0);
                expect(cells[index + 1]!.top).toBe(cells[index]!.top);
                expect(cells[index + 1]!.left).toBeGreaterThan(cells[index]!.left + cells[index]!.width);
                expect(cells[index + 1]!.left + cells[index + 1]!.width).toBeLessThanOrEqual(width - 16);
            }
        }
    });

    it('collapses to a single column below the medium viewport', async () => {
        dimensionsRef.width = 480;
        dimensionsRef.height = 900;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');

        const screen = await renderScreen(
            <ItemSection testID="usage" caption="Usage" columns={2} collapseBelow="medium">
                <ItemGroupColumn>
                    <View testID="cell-1" />
                </ItemGroupColumn>
                <ItemGroupColumn>
                    <View testID="cell-2" />
                </ItemGroupColumn>
            </ItemSection>,
        );

        const cells = await layoutCells(screen, ['cell-1', 'cell-2'], 390);
        expect(cells[0]!.width).toBe(358);
        expect(cells[1]!.left).toBe(cells[0]!.left);
        expect(cells[1]!.top).toBeGreaterThan(cells[0]!.top + cells[0]!.height);
    });

    it('honors partial and full-row spans without overflowing a three-column section', async () => {
        dimensionsRef.width = 1000;
        dimensionsRef.height = 800;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');
        const screen = await renderScreen(
            <ItemSection columns={3}>
                <ItemGroupColumn span={2}><View testID="wide" /></ItemGroupColumn>
                <ItemGroupColumn><View testID="single" /></ItemGroupColumn>
                <ItemGroupColumn span={3}><View testID="full" /></ItemGroupColumn>
                <ItemGroupColumn><View testID="last" /></ItemGroupColumn>
            </ItemSection>,
        );
        const [wide, single, full, last] = await layoutCells(screen, ['wide', 'single', 'full', 'last'], 836);
        expect(wide!.width).toBe(532);
        expect(single!.width).toBe(260);
        expect(single!.top).toBe(wide!.top);
        expect(full!.width).toBe(804);
        expect(full!.top).toBeGreaterThan(wide!.top);
        expect(last!.width).toBe(260);
        expect(last!.top).toBeGreaterThan(full!.top);
    });

    it('applies a barely-there section tint by default and stays plain when tone="plain"', async () => {
        dimensionsRef.width = 1000;
        dimensionsRef.height = 800;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');
        const { Text } = await import('@/components/ui/text/Text');

        const tinted = await renderScreen(
            <ItemSection testID="tinted" caption="Usage">
                <ItemGroupColumn>
                    <Text testID="cell">A</Text>
                </ItemGroupColumn>
            </ItemSection>,
        );
        expect(flattenStyle(tinted.findByTestId('tinted')?.props.style).backgroundColor)
            .toBe(lightTheme.colors.surface.sectionTint);
        // The tint must be subtler than the heavier elevated surface and the recessed inset.
        expect(flattenStyle(tinted.findByTestId('tinted')?.props.style).backgroundColor)
            .not.toBe(lightTheme.colors.surface.elevated);
        expect(flattenStyle(tinted.findByTestId('tinted')?.props.style).backgroundColor)
            .not.toBe(lightTheme.colors.surface.inset);

        const plain = await renderScreen(
            <ItemSection testID="plain" caption="Usage" tone="plain">
                <ItemGroupColumn>
                    <Text testID="cell">A</Text>
                </ItemGroupColumn>
            </ItemSection>,
        );
        expect(flattenStyle(plain.findByTestId('plain')?.props.style).backgroundColor)
            .not.toBe(lightTheme.colors.surface.sectionTint);
    });
});
