import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { MAPBOX_PUBLIC_TOKEN } from '@/lib/mapbox';
import { DriverLocation, RideRequest } from '@/context/DriverRuntime';
import { useColors } from '@/hooks/useColors';

type Coordinate = { latitude: number; longitude: number };
type DriverColors = ReturnType<typeof useColors>;

type MapState = {
  driver: Coordinate | null;
  pickup: Coordinate | null;
  dropoff: Coordinate | null;
  heading: number;
  following: boolean;
};

function coordinateFromLocation(location?: { lat: number; lng: number } | null): Coordinate | null {
  if (!location) return null;
  const latitude = Number(location.lat);
  const longitude = Number(location.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
}

function coordinateFromDriver(location: DriverLocation | null): Coordinate | null {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  return { latitude: location.latitude, longitude: location.longitude };
}

function escapeScriptValue(value: string) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function createNavigationMapHtml(token: string, initial: MapState) {
  const initialJson = JSON.stringify({
    ...initial,
    driver: initial.driver ? [initial.driver.longitude, initial.driver.latitude] : null,
    pickup: initial.pickup ? [initial.pickup.longitude, initial.pickup.latitude] : null,
    dropoff: initial.dropoff ? [initial.dropoff.longitude, initial.dropoff.latitude] : null,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.css">
<style>
html,body,#map{margin:0;width:100%;height:100%;overflow:hidden;background:#07111f}
.map-pin{width:22px;height:22px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 7px #0008}
.map-pin.pickup{background:#22c55e}.map-pin.dropoff{background:#ef4444}.map-pin.driver{background:#38bdf8}
</style>
</head>
<body>
<div id="map" aria-label="Driver navigation map"></div>
<script src="https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.js"></script>
<script>
const token=${escapeScriptValue(token)};
const initialState=${initialJson};
const rtlPlugin='https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js';
if (window.mapboxgl) {
  mapboxgl.accessToken=token;
  if (mapboxgl.setRTLTextPlugin) {
    mapboxgl.setRTLTextPlugin(rtlPlugin, error => error && console.warn('Mapbox RTL text plugin could not load:', error), true);
  }
}
let map;
let currentState=initialState;
let suppressGesture=false;
const markers={};
function send(type, extra) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type}, extra || {})));
}
function markerElement(kind) {
  const element=document.createElement('div');
  element.className='map-pin '+kind;
  element.setAttribute('aria-label', kind==='pickup'?'Pickup':kind==='dropoff'?'Drop-off':'Driver location');
  return element;
}
function setMarker(key, coordinate, kind) {
  if (!map) return;
  if (!coordinate) {
    if (markers[key]) { markers[key].remove(); delete markers[key]; }
    return;
  }
  const lngLat=[coordinate[0],coordinate[1]];
  if (!markers[key]) markers[key]=new mapboxgl.Marker({element:markerElement(kind)});
  markers[key].setLngLat(lngLat).addTo(map);
}
function updateRoute() {
  if (!map || !map.isStyleLoaded()) return;
  const points=[currentState.driver,currentState.pickup,currentState.dropoff].filter(Boolean);
  const coordinates=points.length > 1 ? points : [];
  if (!map.getSource('driver-navigation-route')) {
    map.addSource('driver-navigation-route',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates}}});
    map.addLayer({id:'driver-navigation-route-line',type:'line',source:'driver-navigation-route',paint:{'line-color':'#38bdf8','line-width':4,'line-opacity':.72}});
  } else {
    map.getSource('driver-navigation-route').setData({type:'Feature',geometry:{type:'LineString',coordinates}});
  }
}
function applyState(next) {
  currentState=Object.assign({},currentState,next || {});
  setMarker('pickup',currentState.pickup,'pickup');
  setMarker('dropoff',currentState.dropoff,'dropoff');
  setMarker('driver',currentState.following ? null : currentState.driver,'driver');
  updateRoute();
  if (map && currentState.following && currentState.driver) {
    suppressGesture=true;
    map.easeTo({center:currentState.driver,bearing:Number(currentState.heading)||0,pitch:45,zoom:16,duration:500});
    window.setTimeout(()=>{suppressGesture=false},550);
  }
}
function recenter(next) {
  applyState(next);
  const center=currentState.driver || currentState.pickup || currentState.dropoff;
  if (!map || !center) return;
  suppressGesture=true;
  map.easeTo({center,bearing:Number(currentState.heading)||0,pitch:45,zoom:16,duration:500});
  window.setTimeout(()=>{suppressGesture=false},550);
}
if (window.mapboxgl && token) {
  const center=initialState.driver || initialState.pickup || initialState.dropoff || [69.3451,30.3753];
  map=new mapboxgl.Map({
    container:'map',
    style:'mapbox://styles/mapbox/streets-v12',
    center,
    zoom:16,
    pitch:45,
    bearing:Number(initialState.heading)||0,
    localIdeographFontFamily:'sans-serif',
    attributionControl:true,
    dragRotate:true,
    touchPitch:true
  });
  map.on('load',()=>{ applyState(currentState); send('ready'); });
  ['dragstart','zoomstart','rotatestart','pitchstart'].forEach(eventName => {
    map.on(eventName,()=>{ if (!suppressGesture) send('user-gesture'); });
  });
  map.on('error',event=>{ if (event && event.error) send('error',{message:String(event.error.message || event.error)}); });
} else {
  send('error',{message:'Mapbox is not configured'});
}
window.addEventListener('message',event=>{
  try {
    const message=JSON.parse(event.data || '{}');
    if (message.type==='state') applyState(message.state);
    if (message.type==='recenter') recenter(message.state);
  } catch (error) {
    console.warn('Invalid native map message',error);
  }
});
</script>
</body>
</html>`;
}

export function DriverMapboxWebView({
  ride,
  driverLocation,
  colors,
}: {
  ride: RideRequest | null;
  driverLocation: DriverLocation | null;
  colors: DriverColors;
}) {
  const webViewRef = useRef<WebView>(null);
  const previousLocation = useRef<Coordinate | null>(null);
  const headingRef = useRef<number>(0);
  const [following, setFollowing] = useState(true);
  const [mapReady, setMapReady] = useState(false);

  const driver = coordinateFromDriver(driverLocation);
  const pickup = coordinateFromLocation(ride?.pickupLocation);
  const dropoff = coordinateFromLocation(ride?.dropoffLocation);
  const initial = useMemo<MapState>(() => ({
    driver,
    pickup,
    dropoff,
    heading: headingRef.current,
    following: true,
  }), [driver?.latitude, driver?.longitude, pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude]);
  const html = useMemo(
    () => createNavigationMapHtml(MAPBOX_PUBLIC_TOKEN, {
      ...initial,
      following: true,
    }),
    [],
  );

  useEffect(() => {
    if (!driver) return;
    if (driverLocation?.heading !== undefined && Number.isFinite(driverLocation.heading)) {
      headingRef.current = Number(driverLocation.heading);
    } else if (previousLocation.current) {
      const deltaLat = driver.latitude - previousLocation.current.latitude;
      const deltaLng = driver.longitude - previousLocation.current.longitude;
      if (Math.abs(deltaLat) + Math.abs(deltaLng) > 0.00001) {
        headingRef.current = (Math.atan2(deltaLng, deltaLat) * 180 / Math.PI + 360) % 360;
      }
    }
    previousLocation.current = driver;
  }, [driver?.latitude, driver?.longitude, driverLocation?.heading]);

  const state = useMemo<MapState>(() => ({
    driver,
    pickup,
    dropoff,
    heading: headingRef.current,
    following,
  }), [driver?.latitude, driver?.longitude, pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude, following, driverLocation?.heading]);

  useEffect(() => {
    if (!mapReady) return;
    webViewRef.current?.postMessage(JSON.stringify({ type: 'state', state }));
  }, [mapReady, state]);

  useEffect(() => {
    setFollowing(true);
    if (mapReady) {
      webViewRef.current?.postMessage(JSON.stringify({
        type: 'recenter',
        state: { ...state, following: true },
      }));
    }
  }, [ride?.id]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data || '{}');
      if (message.type === 'ready') setMapReady(true);
      if (message.type === 'user-gesture') setFollowing(false);
    } catch {
      // Ignore malformed messages from the map document.
    }
  };

  const recenter = () => {
    setFollowing(true);
    webViewRef.current?.postMessage(JSON.stringify({
      type: 'recenter',
      state: { ...state, following: true },
    }));
  };

  return <View style={[styles.navigationCard, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius + 12 }]}>
    <View style={styles.navigationHeader}>
      <View style={styles.statusRow}>
        <Ionicons name="navigate" size={18} color={colors.primary} />
        <View>
          <Text style={[styles.navigationTitle, { color: colors.foreground }]}>Driver navigation</Text>
          <Text style={[styles.navigationSubtitle, { color: colors.mutedForeground }]}>
            {following ? 'Following your live position' : 'Map movement paused'}
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityLabel="Recenter navigation map"
        testID="driver-map-recenter"
        onPress={recenter}
        style={[styles.recenterButton, { borderColor: following ? colors.primary : colors.border }]}
      >
        <Ionicons name="locate-outline" size={19} color={following ? colors.primary : colors.mutedForeground} />
      </Pressable>
    </View>
    <View style={styles.navigationMapFrame}>
      <View style={styles.navigationMap}>
        <WebView
          ref={webViewRef}
          source={{ html }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          onLoadEnd={() => {
            webViewRef.current?.postMessage(JSON.stringify({ type: 'state', state }));
          }}
          onMessage={onMessage}
          onError={() => setMapReady(false)}
          style={StyleSheet.absoluteFill}
          allowsInlineMediaPlayback
          mixedContentMode="compatibility"
        />
        {following && <View pointerEvents="none" style={styles.fixedDriverMarker}>
          <View style={[styles.fixedDriverMarkerHalo, { borderColor: colors.primary }]} />
          <View style={[styles.fixedDriverMarkerDot, { backgroundColor: colors.primary, borderColor: colors.primaryForeground }]} />
          <View style={[styles.fixedDriverMarkerArrow, { borderBottomColor: colors.primary }]} />
        </View>}
        {!driver && <View pointerEvents="none" style={[styles.gpsStatus, { backgroundColor: colors.card }]}>
          <Ionicons name="locate-outline" size={14} color={colors.primary} />
          <Text style={[styles.gpsStatusText, { color: colors.foreground }]}>Waiting for live GPS</Text>
        </View>}
        {!following && <View pointerEvents="none" style={[styles.pausedBadge, { backgroundColor: colors.card }]}>
          <Text style={[styles.gpsStatusText, { color: colors.foreground }]}>Follow paused</Text>
        </View>}
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  navigationCard: { marginTop: 18, borderWidth: 1, padding: 12, overflow: 'hidden' },
  navigationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 3, paddingBottom: 10 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  navigationTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  navigationSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  recenterButton: { width: 38, height: 38, borderWidth: 1, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  navigationMapFrame: { height: 310, overflow: 'hidden', borderRadius: 10, position: 'relative' },
  navigationMap: { flex: 1, position: 'relative' },
  fixedDriverMarker: { position: 'absolute', top: '50%', left: '50%', width: 44, height: 54, marginLeft: -22, marginTop: -27, alignItems: 'center', justifyContent: 'center' },
  fixedDriverMarkerHalo: { position: 'absolute', width: 38, height: 38, borderRadius: 19, borderWidth: 2, opacity: .28 },
  fixedDriverMarkerDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, zIndex: 2 },
  fixedDriverMarkerArrow: { position: 'absolute', bottom: 3, width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', zIndex: 1 },
  gpsStatus: { position: 'absolute', left: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 15, opacity: .95 },
  gpsStatusText: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  pausedBadge: { position: 'absolute', top: 12, left: 12, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 15, opacity: .95 },
});