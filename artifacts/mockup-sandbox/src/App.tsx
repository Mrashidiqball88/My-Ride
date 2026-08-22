import React from 'react';
import DriverWalletScreen from './DriverWalletScreen';
import DriverWalletVariant from './components/mockups/driver-wallet/DriverWalletVariant';

// Minimal path-based router for /preview/<ComponentName>
const path = window.location.pathname;

const routes: Record<string, React.ComponentType> = {
  '/preview/DriverWalletVariant': DriverWalletVariant,
  '/preview/DriverWalletScreen': DriverWalletScreen,
};

const Component = routes[path] ?? DriverWalletScreen;

export default function App() {
  return <Component />;
}
