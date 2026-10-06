import React, { useState, useEffect } from 'react';
import { View, Platform } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { TerminalConnectRouteShell } from '@/components/terminal/connect/TerminalConnectRouteShell';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot, getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { clearPendingTerminalConnect, getPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import {
    buildTerminalConnectDeepLink,
    parseTerminalConnectUrl,
    type ParsedTerminalConnectUrl,
} from '@/utils/path/terminalConnectUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';

export default function TerminalConnectScreen() {
    const router = useRouter();
    const routeHash = useLocalSearchParams<{ '#': string }>()['#'];
    const processedRouteHashRef = React.useRef<string | undefined>(undefined);
    const { theme } = useUnistyles();
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [serverUrlFromHash, setServerUrlFromHash] = useState<string | null>(null);
    const [pairing, setPairing] = useState<ParsedTerminalConnectUrl['pairing']>(undefined);
    const [hashProcessed, setHashProcessed] = useState(false);
    const auth = useAuth();
    const authRedirectTriggeredRef = React.useRef(false);

    const navigateBackOrToHome = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);
    const openRelayCustomFlow = React.useCallback(() => {
        router.push('/setup?openCustom=1');
    }, [router]);
    const renderInShell = React.useCallback(
        (children: React.ReactNode) => (
            <TerminalConnectRouteShell
                enabled={!auth.isAuthenticated}
                stepId="terminal-connect"
                testID="unauth-shell-route-terminal-connect"
                contentTestID="terminal-connect-route-content"
                onBack={navigateBackOrToHome}
                onOpenRelayCustomFlow={openRelayCustomFlow}
            >
                {children}
            </TerminalConnectRouteShell>
        ),
        [auth.isAuthenticated, navigateBackOrToHome, openRelayCustomFlow],
    );

    const { processAuthUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            navigateBackOrToHome();
        },
        allowLoopbackServerOverride: true,
    });

    // Extract key from hash on web platform
    useEffect(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            if (hashProcessed && (!routeHash || processedRouteHashRef.current === routeHash)) return;
            processedRouteHashRef.current = routeHash;
            const sourceUrl = routeHash
                ? `${window.location.href.split('#')[0]}#${routeHash}`
                : window.location.href;
            const parsed = parseTerminalConnectUrl(sourceUrl);
            if (parsed?.publicKeyB64Url) {
                authRedirectTriggeredRef.current = false;
                setPublicKey(parsed.publicKeyB64Url);
                setPairing(parsed.pairing);

                const activeServerSnapshot = getActiveServerSnapshot();
                const activeServerUrl = normalizeServerUrl(activeServerSnapshot.serverUrl);
                const requestedServerUrl = normalizeServerUrl(parsed.serverUrl ?? '');
                const effectiveTarget = resolveEffectiveServerUrlOverride({
                    requestedServerUrl,
                    activeServerUrl,
                    equivalentActiveServerUrls: [
                        activeServerSnapshot.activeShareableServerUrl,
                        activeServerSnapshot.activeLocalRelayUrl,
                    ],
                    allowLoopbackSwitch: true,
                });
                const desiredServerUrl = effectiveTarget || activeServerUrl || getActiveServerUrl();

                if (desiredServerUrl) {
                    // Persist the connect link in storage so dev strict-mode remounts still have access
                    // after we clear the URL (hash/query) for safety.
                    setPendingTerminalConnect({
                        publicKeyB64Url: parsed.publicKeyB64Url,
                        serverUrl: desiredServerUrl,
                        ...(parsed.pairing ? { pairing: parsed.pairing } : {}),
                    });
                    setServerUrlFromHash(desiredServerUrl);
                }

                // Clear sensitive params from the URL to avoid exposing the key in history.
                window.history.replaceState(null, '', window.location.pathname);
            } else {
                const pending = getPendingTerminalConnect();
                if (pending?.publicKeyB64Url) {
                    setPublicKey(pending.publicKeyB64Url);
                    setServerUrlFromHash(pending.serverUrl);
                    setPairing(pending.pairing);
                }
            }
            setHashProcessed(true);
        }
    }, [hashProcessed, routeHash]);

    useEffect(() => {
        if (auth.isAuthenticated) return;
        if (!hashProcessed || !publicKey) return;
        if (authRedirectTriggeredRef.current) return;

        authRedirectTriggeredRef.current = true;
        const activeServerSnapshot = getActiveServerSnapshot();
        const activeServerUrl = normalizeServerUrl(activeServerSnapshot.serverUrl);
        const effectiveTarget = resolveEffectiveServerUrlOverride({
            requestedServerUrl: serverUrlFromHash,
            activeServerUrl,
            equivalentActiveServerUrls: [
                activeServerSnapshot.activeShareableServerUrl,
                activeServerSnapshot.activeLocalRelayUrl,
            ],
            allowLoopbackSwitch: true,
        });
        const desiredServerUrl = effectiveTarget || activeServerUrl || getActiveServerUrl();
        setPendingTerminalConnect({
            publicKeyB64Url: publicKey,
            serverUrl: desiredServerUrl,
            ...(pairing ? { pairing } : {}),
        });

        fireAndForget((async () => {
            const storedCredentials = auth.credentials ?? await TokenStorage.getCredentials();
            if (storedCredentials) return;

            await auth.refreshFromActiveServer();
            const refreshedCredentials = await TokenStorage.getCredentials();
            if (refreshedCredentials) return;

            if (effectiveTarget) {
                try {
                    await upsertActivateAndSwitchServer({
                        serverUrl: effectiveTarget,
                        source: 'url',
                        scope: 'device',
                        refreshAuth: auth.refreshFromActiveServer,
                    });
                } catch {
                    // ignore; auth entry route can still proceed and recover later
                }
            }
            router.replace('/');
        })(), { tag: 'TerminalConnectScreen.redirectToAuth' });
    }, [auth.credentials, auth.isAuthenticated, auth.refreshFromActiveServer, hashProcessed, pairing, publicKey, router, serverUrlFromHash]);

    const handleConnect = async () => {
        if (publicKey) {
            const authUrl = buildTerminalConnectDeepLink({
                publicKeyB64Url: publicKey,
                serverUrl: serverUrlFromHash,
                pairing,
            });
            await processAuthUrl(authUrl);
        }
    };

    const handleReject = () => {
        clearPendingTerminalConnect();
        navigateBackOrToHome();
    };

    // Show placeholder for mobile platforms
    if (Platform.OS !== 'web') {
        return renderInShell(
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Icon
                            name="laptop"
                            size={64} 
                            color={theme.colors.text.secondary}
                            style={{ marginBottom: 16 }} 
                        />
                        <Text style={{ 
                            ...Typography.default('semiBold'), 
                            fontSize: 18, 
                            textAlign: 'center',
                            marginBottom: 12 
                        }}>
                            {t('terminal.webBrowserRequired')}
                        </Text>
                        <Text style={{ 
                            ...Typography.default(), 
                            fontSize: 14, 
                            color: theme.colors.text.secondary,
                            textAlign: 'center',
                            lineHeight: 20 
                        }}>
                            {t('terminal.webBrowserRequiredDescription')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>,
        );
    }

    // Show loading state while processing hash
    if (!hashProcessed) {
        return renderInShell(
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Text style={{ ...Typography.default(), color: theme.colors.text.secondary }}>
                            {t('terminal.processingConnection')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>,
        );
    }

    if (!auth.isAuthenticated && publicKey) {
        return renderInShell(
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Text style={{ ...Typography.default(), color: theme.colors.text.secondary, textAlign: 'center', lineHeight: 20 }}>
                            {t('modals.pleaseSignInFirst')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>,
        );
    }

    // Show error if no key found
    if (!publicKey) {
        return renderInShell(
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Icon
                            name="warning"
                            size={48} 
                            color={theme.colors.state.danger.foreground}
                            style={{ marginBottom: 16 }} 
                        />
                        <Text style={{ 
                            ...Typography.default('semiBold'), 
                            fontSize: 16, 
                            color: theme.colors.state.danger.foreground,
                            textAlign: 'center',
                            marginBottom: 8 
                        }}>
                            {t('terminal.invalidConnectionLink')}
                        </Text>
                        <Text style={{ 
                            ...Typography.default(), 
                            fontSize: 14, 
                            color: theme.colors.text.secondary,
                            textAlign: 'center',
                            lineHeight: 20 
                        }}>
                            {t('terminal.invalidConnectionLinkDescription')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>,
        );
    }

    // Show confirmation screen for valid connection
    return renderInShell(
        <ItemList>
            {/* Connection Request Header */}
            <ItemGroup>
                <View style={{ 
                    alignItems: 'center',
                    paddingVertical: 24,
                    paddingHorizontal: 16
                }}>
                    <Icon
                        name="terminal"
                        size={48} 
                        color={theme.colors.accent.blue}
                        style={{ marginBottom: 16 }} 
                    />
                    <Text style={{ 
                        ...Typography.default('semiBold'), 
                        fontSize: 20, 
                        textAlign: 'center',
                        marginBottom: 12
                    }}>
                        {t('terminal.connectTerminal')}
                    </Text>
                    <Text style={{ 
                        ...Typography.default(), 
                        fontSize: 14, 
                        color: theme.colors.text.secondary,
                        textAlign: 'center',
                        lineHeight: 20 
                    }}>
                        {t('terminal.terminalRequestDescription')}
                    </Text>
                </View>
            </ItemGroup>

            {/* Connection Details */}
            <ItemGroup title={t('terminal.connectionDetails')}>
                <Item
                    title={t('terminal.publicKey')}
                    detail={`${publicKey.substring(0, 12)}...`}
                    icon={<Icon name="key" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                />
                <Item
                    title={t('terminal.encryption')}
                    detail={t('terminal.endToEndEncrypted')}
                    icon={<Icon name="lock" size={29} color={theme.colors.state.success.foreground} />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Action Buttons */}
            <ItemGroup>
                <View style={{ 
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    gap: 12 
                }}>
                    <RoundButton
                        testID="terminal-connect-approve"
                        title={isLoading ? t('terminal.connecting') : t('terminal.acceptConnection')}
                        onPress={handleConnect}
                        size="large"
                        disabled={isLoading}
                        loading={isLoading}
                    />
                    <RoundButton
                        testID="terminal-connect-reject"
                        title={t('terminal.reject')}
                        onPress={handleReject}
                        size="large"
                        display="inverted"
                        disabled={isLoading}
                    />
                </View>
            </ItemGroup>

            {/* Security Notice */}
            <ItemGroup 
                title={t('terminal.security')}
                footer={t('terminal.securityFooter')}
            >
                <Item
                    title={t('terminal.clientSideProcessing')}
                    subtitle={t('terminal.linkProcessedLocally')}
                    icon={<Icon name="shield-check" size={29} color={theme.colors.state.success.foreground} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>,
    );
}
