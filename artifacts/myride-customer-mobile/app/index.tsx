import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewNavigation } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

const CUSTOMER_PATH = '/customer';

function getCustomerUrl() {
  const explicitUrl = String(process.env.EXPO_PUBLIC_CUSTOMER_URL || '').trim();
  if (explicitUrl) return explicitUrl.replace(/\/+$/, '');

  const domain = String(process.env.EXPO_PUBLIC_DOMAIN || '').trim();
  return domain ? `https://${domain}${CUSTOMER_PATH}` : '';
}

function getOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export default function CustomerWebViewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const customerUrl = useMemo(getCustomerUrl, []);
  const allowedOrigin = useMemo(() => getOrigin(customerUrl), [customerUrl]);
  const topInset = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomInset = insets.bottom + (Platform.OS === 'web' ? 34 : 0);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      setLoadError('This link could not be opened on your device.');
    }
  }, []);

  const allowNavigation = useCallback((request: WebViewNavigation) => {
    if (!allowedOrigin) return false;
    let requestedOrigin = '';
    try {
      requestedOrigin = new URL(request.url).origin;
    } catch {
      return false;
    }
    if (requestedOrigin === allowedOrigin) return true;
    if (request.url !== 'about:blank' && !request.url.startsWith('javascript:')) {
      void openExternalUrl(request.url);
    }
    return false;
  }, [allowedOrigin, openExternalUrl]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) return false;
      webViewRef.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [canGoBack]);

  const retry = () => {
    setLoadError(null);
    setLoading(true);
    if (webViewRef.current) {
      webViewRef.current.reload();
    } else {
      setReloadNonce(current => current + 1);
    }
  };

  if (!customerUrl) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: topInset, paddingBottom: bottomInset }]}>
        <Ionicons name="cloud-offline-outline" size={44} color={colors.primary} />
        <Text style={[styles.title, { color: colors.foreground }]}>Customer app address is missing</Text>
        <Text style={[styles.message, { color: colors.mutedForeground }]}>
          This build has not received the My Ride Customer web address yet.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: topInset, paddingBottom: bottomInset }]}>
      <WebView
        key={reloadNonce}
        ref={webViewRef}
        source={{ uri: customerUrl }}
        style={styles.webView}
        originWhitelist={['https://*', 'http://*']}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        allowsBackForwardNavigationGestures
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={allowNavigation}
        onNavigationStateChange={state => setCanGoBack(state.canGoBack)}
        onLoadStart={() => {
          setLoading(true);
          setLoadError(null);
        }}
        onLoadEnd={() => setLoading(false)}
        onError={event => {
          setLoading(false);
          setLoadError(event.nativeEvent.description || 'The Customer app could not be loaded.');
        }}
      />
      {loading && !loadError && (
        <View pointerEvents="none" style={[styles.loadingOverlay, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading My Ride</Text>
        </View>
      )}
      {loadError && (
        <View style={[styles.errorOverlay, { backgroundColor: colors.background }]}>
          <Ionicons name="wifi-outline" size={44} color={colors.primary} />
          <Text style={[styles.title, { color: colors.foreground }]}>Couldn’t connect</Text>
          <Text style={[styles.message, { color: colors.mutedForeground }]}>{loadError}</Text>
          <Pressable
            testID="customer-webview-retry"
            accessibilityRole="button"
            accessibilityLabel="Retry loading Customer app"
            onPress={retry}
            style={({ pressed }) => [
              styles.retryButton,
              { backgroundColor: colors.primary, opacity: pressed ? 0.75 : 1 },
            ]}
          >
            <Ionicons name="refresh" size={18} color={colors.primaryForeground} />
            <Text style={[styles.retryText, { color: colors.primaryForeground }]}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  webView: { flex: 1, backgroundColor: 'transparent' },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 12,
  },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 22,
    textAlign: 'center',
  },
  message: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    maxWidth: 340,
  },
  retryButton: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  retryText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
});