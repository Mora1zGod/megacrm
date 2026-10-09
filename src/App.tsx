import { BrowserRouter } from 'react-router-dom';
import { SupabaseProvider } from './app/providers/SupabaseProvider';
import { AuthProvider } from './app/providers/AuthProvider';
import { AppUserProvider } from './app/providers/AppUserProvider';
import { PermissionsProvider } from './app/providers/PermissionsProvider';
import { AppRouter } from './app/router';
import { Toaster } from './components/ui/sonner';
import { AppErrorBoundary } from './components/AppErrorBoundary';

export default function App() {
  return (
    <AppErrorBoundary>
    <SupabaseProvider>
      <AuthProvider>
        <AppUserProvider>
          <PermissionsProvider>
            <BrowserRouter>
              <AppRouter />
              <Toaster />
            </BrowserRouter>
          </PermissionsProvider>
        </AppUserProvider>
      </AuthProvider>
    </SupabaseProvider>
    </AppErrorBoundary>
  );
}
