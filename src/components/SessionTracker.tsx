'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

export function SessionTracker() {
  const pathname = usePathname();

  useEffect(() => {
    const checkSessionResume = async () => {
      try {
        if (pathname === '/login') {
          return;
        }

        const authCookie = document.cookie.split(';').find(cookie => {
          const trimmed = cookie.trim();
          return trimmed.startsWith('user_auth=') || trimmed.startsWith('auth=');
        });

        if (!authCookie) {
          return;
        }

        const lastRecordedLogin = localStorage.getItem('lastRecordedLogin');
        const now = Date.now();
        const sessionTimeout = 4 * 60 * 60 * 1000;

        const shouldRecordLogin = !lastRecordedLogin ||
          (now - parseInt(lastRecordedLogin)) > sessionTimeout;

        if (shouldRecordLogin) {
          console.log('检测到新会话，记录登入时间');

          const response = await fetch('/api/user/my-stats', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loginTime: now })
          });

          if (response.ok) {
            localStorage.setItem('lastRecordedLogin', now.toString());
            console.log('会话恢复登入时间记录成功');
          } else {
            console.warn('会话恢复登入时间记录失败:', response.status);
          }
        }
      } catch (error) {
        console.error('会话检测失败:', error);
      }
    };

    checkSessionResume();

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        setTimeout(checkSessionResume, 1000);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [pathname]);

  return null;
}
