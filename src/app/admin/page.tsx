'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Users, Database, LogOut, ArrowLeft, Settings } from 'lucide-react';
import { toast } from 'sonner';
import MaintenanceDashboard from '@/components/MaintenanceDashboard';

export default function AdminPage() {
  const [user, setUser] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'maintenance'>('info');
  const router = useRouter();

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) {
          setUser(data.user);
        } else {
          router.push('/login');
        }
      });
  }, [router]);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    toast.success('Logged out successfully');
    router.push('/login');
    router.refresh();
  };

  if (!user) return <div className="flex h-screen items-center justify-center">Loading...</div>;

  return (
    <div className="min-h-screen bg-muted/40 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">Admin Dashboard</h1>
            <p className="text-muted-foreground">Manage your application and monitor performance.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.push('/')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Editor
            </Button>
            <Button variant="destructive" onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>

        <div className="flex border-b">
          <button 
            onClick={() => setActiveTab('info')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'info' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            System Info
          </button>
          <button 
            onClick={() => setActiveTab('maintenance')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'maintenance' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            Maintenance
          </button>
        </div>

        {activeTab === 'info' ? (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Role</CardTitle>
                  <ShieldCheck className="h-4 w-4 text-primary" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold capitalize">{user.role}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Username</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{user.username}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Active Session</CardTitle>
                  <Database className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">24 Hours</div>
                </CardContent>
              </Card>
            </div>

            <Card className="col-span-3">
              <CardHeader>
                <CardTitle>System Information</CardTitle>
                <CardDescription>
                  Environment and configuration details.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 border-b pb-2">
                    <span className="font-medium">Authentication Mode</span>
                    <span className="text-muted-foreground text-right">Environment Variable (RBAC)</span>
                  </div>
                  <div className="grid grid-cols-2 border-b pb-2">
                    <span className="font-medium">Admin Access</span>
                    <span className="text-primary text-right font-bold">ENABLED</span>
                  </div>
                  <div className="grid grid-cols-2 border-b pb-2">
                    <span className="font-medium">User Access</span>
                    <span className="text-primary text-right font-bold">ENABLED</span>
                  </div>
                  <div className="grid grid-cols-2">
                    <span className="font-medium">API Security</span>
                    <span className="text-muted-foreground text-right">JWT Cookie / Middleware Protected</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <MaintenanceDashboard />
        )}
      </div>
    </div>
  );
}
