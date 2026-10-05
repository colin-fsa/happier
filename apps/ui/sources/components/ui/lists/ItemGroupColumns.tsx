import * as React from 'react';
import { View, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveViewportClass, type ViewportClass } from '@/utils/platform/viewportClass';

type ItemGroupColumnsContextValue = Readonly<{
    activeColumns: number;
    columnWidth: number | null;
    columnGap: number;
}>;

const ItemGroupColumnsContext = React.createContext<ItemGroupColumnsContextValue>({ activeColumns: 1, columnWidth: null, columnGap: 0 });

const VIEWPORT_CLASS_ORDER: Record<ViewportClass, number> = Object.freeze({
    compact: 0,
    medium: 1,
    expanded: 2,
    wide: 3,
});

export type ItemGroupColumnsProps = Readonly<{
    children: React.ReactNode;
    columns?: 1 | 2 | 3;
    collapseBelow?: ViewportClass;
    /**
     * Explicit resolved column count, bypassing the viewport-class rule.
     *
     * Callers that must know the count BEFORE rendering — e.g. to distribute
     * rows into per-column stacks — resolve it themselves and pass it down, so
     * the layout and the distribution can never disagree.
     */
    activeColumns?: number;
    style?: StyleProp<ViewStyle>;
    paddingHorizontal?: number;
    paddingVertical?: number;
    columnGap?: number;
    rowGap?: number;
}>;

export type ItemGroupColumnProps = Readonly<{
    children: React.ReactNode;
    span?: 1 | 2 | 3;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create(() => ({
    container: {
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
    },
    column: {
        minWidth: 0,
    },
    fullWidthColumn: {
        width: '100%',
        flexBasis: '100%',
    },
}));

export function resolveItemGroupActiveColumns(params: Readonly<{
    viewportClass: ViewportClass;
    columns: number;
    collapseBelow: ViewportClass;
}>): number {
    return VIEWPORT_CLASS_ORDER[params.viewportClass] >= VIEWPORT_CLASS_ORDER[params.collapseBelow]
        ? Math.max(1, params.columns)
        : 1;
}

export const ItemGroupColumns = React.memo<ItemGroupColumnsProps>((props) => {
    const { width, height } = useWindowDimensions();
    const styles = stylesheet;
    const [containerWidth, setContainerWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        setContainerWidth(event.nativeEvent.layout.width);
    }, []);
    const paddingHorizontal = props.paddingHorizontal ?? 16;
    const columnGap = props.columnGap ?? 12;
    const viewportClass = resolveViewportClass({ width, height });
    const activeColumns = props.activeColumns != null
        ? Math.max(1, Math.floor(props.activeColumns))
        : resolveItemGroupActiveColumns({
            viewportClass,
            columns: props.columns ?? 2,
            collapseBelow: props.collapseBelow ?? 'medium',
        });
    // Size from the card itself, not the viewport. A zero flex basis lets every
    // cell shrink onto one line, so flexWrap never enforces the column count.
    const columnWidth = containerWidth === null ? null
        : Math.max(0, (containerWidth - 2 * paddingHorizontal - (activeColumns - 1) * columnGap) / activeColumns);
    const contextValue = React.useMemo<ItemGroupColumnsContextValue>(() => ({
        activeColumns, columnWidth, columnGap,
    }), [activeColumns, columnWidth, columnGap]);

    return (
        <ItemGroupColumnsContext.Provider value={contextValue}>
            <View
                onLayout={onLayout}
                style={[
                    styles.container,
                    {
                        paddingHorizontal,
                        paddingVertical: props.paddingVertical ?? 16,
                        columnGap,
                        rowGap: props.rowGap ?? 16,
                    },
                    props.style,
                ]}
            >
                {props.children}
            </View>
        </ItemGroupColumnsContext.Provider>
    );
});

export const ItemGroupColumn = React.memo<ItemGroupColumnProps>((props) => {
    const styles = stylesheet;
    const { activeColumns, columnWidth, columnGap } = React.useContext(ItemGroupColumnsContext);
    const resolvedSpan = Math.max(1, Math.min(props.span ?? 1, activeColumns));
    const isFullWidth = activeColumns === 1 || resolvedSpan >= activeColumns || columnWidth === null;

    return (
        <View
            style={[
                styles.column,
                isFullWidth
                    ? styles.fullWidthColumn
                    : { width: columnWidth * resolvedSpan + columnGap * (resolvedSpan - 1) },
                props.style,
            ]}
        >
            {props.children}
        </View>
    );
});
