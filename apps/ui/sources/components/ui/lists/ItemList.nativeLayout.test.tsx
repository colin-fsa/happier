import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { describe, expect, it } from 'vitest';
import Yoga, { type Node } from 'yoga-layout';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 390, height: 844 }),
        });
    },
});

const { StyleSheet, View } = await import('react-native');
const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
const { ItemList } = await import('./ItemList');

function applyLayoutStyle(node: Node, style: ViewStyle) {
    if (typeof style.width === 'number') node.setWidth(style.width);
    if (typeof style.height === 'number') node.setHeight(style.height);
    if (typeof style.maxHeight === 'number') node.setMaxHeight(style.maxHeight);
    if (typeof style.minHeight === 'number') node.setMinHeight(style.minHeight);
    if (typeof style.flex === 'number') node.setFlex(style.flex);
    if (typeof style.flexGrow === 'number') node.setFlexGrow(style.flexGrow);
    if (typeof style.flexShrink === 'number') node.setFlexShrink(style.flexShrink);
    if (typeof style.flexBasis === 'number' || style.flexBasis === 'auto') node.setFlexBasis(style.flexBasis);
}

describe('ItemList native layout', () => {
    it.each([
        { layout: 'fit' as const, contentHeight: 400 },
        { layout: 'fit' as const, contentHeight: 1200 },
        { layout: 'fill' as const, contentHeight: 400 },
    ])('keeps $layout card content visible and scrollable at content height $contentHeight', async ({ layout, contentHeight }) => {
        const screen = await renderScreen(
            <ModalCardFrame title="Editor" layout={layout} testID="card">
                <ItemList><View style={{ height: contentHeight }} /></ItemList>
            </ModalCardFrame>,
        );
        const frame = screen.findByTestId('card');
        const body = screen.findByTestId('modal-card-body');
        const scrollView = screen.findByType('ScrollView');
        const clippedSurface = screen.findAllByType('View').find((node) =>
            StyleSheet.flatten(node.props.style)?.overflow === 'hidden');
        if (!frame || !body || !clippedSurface) throw new Error('Missing card layout nodes');

        const root = Yoga.Node.create();
        const surface = Yoga.Node.create();
        const header = Yoga.Node.create();
        const bodyNode = Yoga.Node.create();
        const scrollNode = Yoga.Node.create();
        const content = Yoga.Node.create();
        try {
            applyLayoutStyle(root, StyleSheet.flatten(frame.props.style));
            applyLayoutStyle(surface, StyleSheet.flatten(clippedSurface.props.style));
            applyLayoutStyle(bodyNode, StyleSheet.flatten(body.props.style));
            applyLayoutStyle(scrollNode, StyleSheet.flatten(scrollView.props.style));
            // OS text measurement is the boundary; the actual card/list flex styles stay real.
            header.setHeight(60);
            header.setFlexShrink(0);
            scrollNode.setOverflow(Yoga.OVERFLOW_SCROLL);
            content.setHeight(contentHeight);
            root.insertChild(surface, 0);
            surface.insertChild(header, 0);
            surface.insertChild(bodyNode, 1);
            bodyNode.insertChild(scrollNode, 0);
            scrollNode.insertChild(content, 0);
            root.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);

            const maximumHeight = StyleSheet.flatten(frame.props.style).maxHeight
                ?? StyleSheet.flatten(frame.props.style).height;
            expect(typeof maximumHeight).toBe('number');
            const expectedHeight = layout === 'fill'
                ? Number(maximumHeight) - 60
                : Math.min(contentHeight, Number(maximumHeight) - 60);
            expect(scrollNode.getComputedHeight()).toBeCloseTo(expectedHeight);
            expect(bodyNode.getComputedHeight()).toBeCloseTo(expectedHeight);
            expect(root.getComputedHeight()).toBeCloseTo(expectedHeight + 60);
            expect(content.getComputedHeight()).toBe(contentHeight);
        } finally {
            root.freeRecursive();
        }
    });
});
