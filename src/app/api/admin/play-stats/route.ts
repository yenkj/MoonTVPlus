/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { PlayRecord } from '@/lib/types';

export type { PlayStatsResult } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储进行播放统计查看' },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const username = authInfo.username;
    console.log('play-stats auth check:', {
      username,
      envUsername: process.env.USERNAME,
      isEnvUser: username === process.env.USERNAME,
      authRole: authInfo.role
    });

    let operatorRole: 'owner' | 'admin';
    if (username === process.env.USERNAME) {
      operatorRole = 'owner';
    } else if (authInfo.role === 'owner') {
      operatorRole = 'owner';
    } else {
      const userInfo = await db.getUserInfoV2(username);
      if (!userInfo || userInfo.role !== 'admin' || userInfo.banned) {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
      operatorRole = 'admin';
    }

    const userListResult = await db.getUserListV2(0, 1000, process.env.USERNAME || 'admin');
    const allUsers = userListResult.users;

    const userStats: Array<{
      username: string;
      totalWatchTime: number;
      totalPlays: number;
      lastPlayTime: number;
      recentRecords: PlayRecord[];
      avgWatchTime: number;
      mostWatchedSource: string;
      registrationDays: number;
      lastLoginTime: number;
      loginCount: number;
      createdAt: number;
    }> = [];
    let totalWatchTime = 0;
    let totalPlays = 0;
    const sourceCount: Record<string, number> = {};
    const dailyData: Record<string, { watchTime: number; plays: number }> = {};

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let todayNewUsers = 0;
    let totalRegisteredUsers = 0;
    const registrationData: Record<string, number> = {};

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    for (const user of allUsers) {
      try {
        const PROJECT_START_DATE = new Date('2025-09-14').getTime();
        const userCreatedAt = user.created_at || PROJECT_START_DATE;

        const firstDate = new Date(userCreatedAt);
        const currentDate = new Date();
        const firstDay = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
        const currentDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
        const registrationDays = Math.floor((currentDay.getTime() - firstDay.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        if (userCreatedAt >= todayStart) {
          todayNewUsers++;
        }
        totalRegisteredUsers++;

        if (userCreatedAt >= sevenDaysAgo.getTime()) {
          const regDate = new Date(userCreatedAt).toISOString().split('T')[0];
          registrationData[regDate] = (registrationData[regDate] || 0) + 1;
        }

        let lastLoginTime = 0;
        let loginCount = 0;
        try {
          const userPlayStat = await db.getUserPlayStat(user.username);
          lastLoginTime = userPlayStat.lastLoginTime || userPlayStat.lastLoginDate || userPlayStat.firstLoginTime || 0;
          loginCount = userPlayStat.loginCount || 0;
        } catch (err) {
          lastLoginTime = 0;
          loginCount = 0;
        }

        const userPlayRecords = await db.getAllPlayRecords(user.username);
        const records = Object.values(userPlayRecords);

        if (records.length === 0) {
          userStats.push({
            username: user.username,
            totalWatchTime: 0,
            totalPlays: 0,
            lastPlayTime: 0,
            recentRecords: [],
            avgWatchTime: 0,
            mostWatchedSource: '',
            registrationDays,
            lastLoginTime,
            loginCount,
            createdAt: userCreatedAt,
          });
          continue;
        }

        let userWatchTime = 0;
        let userLastPlayTime = 0;
        const userSourceCount: Record<string, number> = {};

        records.forEach((record) => {
          userWatchTime += record.play_time || 0;

          if (record.save_time > userLastPlayTime) {
            userLastPlayTime = record.save_time;
          }

          const sourceName = record.source_name || '未知来源';
          userSourceCount[sourceName] = (userSourceCount[sourceName] || 0) + 1;
          sourceCount[sourceName] = (sourceCount[sourceName] || 0) + 1;

          const recordDate = new Date(record.save_time);
          if (recordDate >= sevenDaysAgo) {
            const dateKey = recordDate.toISOString().split('T')[0];
            if (!dailyData[dateKey]) {
              dailyData[dateKey] = { watchTime: 0, plays: 0 };
            }
            dailyData[dateKey].watchTime += record.play_time || 0;
            dailyData[dateKey].plays += 1;
          }
        });

        const recentRecords = records
          .sort((a, b) => (b.save_time || 0) - (a.save_time || 0))
          .slice(0, 10);

        let mostWatchedSource = '';
        let maxCount = 0;
        for (const [source, count] of Object.entries(userSourceCount)) {
          if (count > maxCount) {
            maxCount = count;
            mostWatchedSource = source;
          }
        }

        const userStat = {
          username: user.username,
          totalWatchTime: userWatchTime,
          totalPlays: records.length,
          lastPlayTime: userLastPlayTime,
          recentRecords,
          avgWatchTime: records.length > 0 ? userWatchTime / records.length : 0,
          mostWatchedSource,
          registrationDays,
          lastLoginTime: lastLoginTime || userCreatedAt,
          loginCount,
          createdAt: userCreatedAt,
        };

        userStats.push(userStat);

        totalWatchTime += userWatchTime;
        totalPlays += records.length;
      } catch (error) {
        const PROJECT_START_DATE = new Date('2025-09-14').getTime();
        const userCreatedAt = user.created_at || PROJECT_START_DATE;

        const firstDate = new Date(userCreatedAt);
        const currentDate = new Date();
        const firstDay = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
        const currentDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
        const registrationDays = Math.floor((currentDay.getTime() - firstDay.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        userStats.push({
          username: user.username,
          totalWatchTime: 0,
          totalPlays: 0,
          lastPlayTime: 0,
          recentRecords: [],
          avgWatchTime: 0,
          mostWatchedSource: '',
          registrationDays,
          lastLoginTime: userCreatedAt,
          loginCount: 0,
          createdAt: userCreatedAt,
        });
      }
    }

    userStats.sort((a, b) => b.totalWatchTime - a.totalWatchTime);

    const topSources = Object.entries(sourceCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([source, count]) => ({ source, count }));

    const dailyStats: Array<{ date: string; watchTime: number; plays: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateKey = date.toISOString().split('T')[0];
      const data = dailyData[dateKey] || { watchTime: 0, plays: 0 };
      dailyStats.push({
        date: dateKey,
        watchTime: data.watchTime,
        plays: data.plays,
      });
    }

    const registrationStats: Array<{ date: string; newUsers: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateKey = date.toISOString().split('T')[0];
      const newUsers = registrationData[dateKey] || 0;
      registrationStats.push({
        date: dateKey,
        newUsers,
      });
    }

    const oneDayAgo = now.getTime() - 24 * 60 * 60 * 1000;
    const sevenDaysAgoTime = sevenDaysAgo.getTime();
    const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const activeUsers = {
      daily: userStats.filter(user => user.lastLoginTime >= oneDayAgo).length,
      weekly: userStats.filter(user => user.lastLoginTime >= sevenDaysAgoTime).length,
      monthly: userStats.filter(user => user.lastLoginTime >= thirtyDaysAgo).length,
    };

    const result = {
      totalUsers: allUsers.length,
      totalWatchTime,
      totalPlays,
      avgWatchTimePerUser: allUsers.length > 0 ? totalWatchTime / allUsers.length : 0,
      avgPlaysPerUser: allUsers.length > 0 ? totalPlays / allUsers.length : 0,
      userStats,
      topSources,
      dailyStats,
      registrationStats: {
        todayNewUsers,
        totalRegisteredUsers,
        registrationTrend: registrationStats,
      },
      activeUsers,
    };

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '获取播放统计失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
