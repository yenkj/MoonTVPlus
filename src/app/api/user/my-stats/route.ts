/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';

function calculateRegistrationDays(startDate: number): number {
  if (!startDate || startDate <= 0) return 0;

  const firstDate = new Date(startDate);
  const currentDate = new Date();

  const firstDay = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
  const currentDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());

  const daysDiff = Math.floor((currentDay.getTime() - firstDay.getTime()) / (1000 * 60 * 60 * 24));
  return daysDiff + 1;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!db.isStatsSupported()) {
      return NextResponse.json(
        {
          error: '当前存储类型不支持播放统计功能，请使用 Redis、Upstash 或 Kvrocks',
          supportedTypes: ['redis', 'upstash', 'kvrocks']
        },
        { status: 400 }
      );
    }

    const envUsername = process.env.USERNAME;
    let userCreatedAt: number;

    if (authInfo.username === envUsername) {
      userCreatedAt = Date.now();
    } else {
      const userInfo = await db.getUserInfoV2(authInfo.username);
      if (!userInfo) {
        return NextResponse.json({ error: '用户不存在' }, { status: 401 });
      }
      if (userInfo.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
      userCreatedAt = userInfo.created_at || Date.now();
    }

    const userStats = await db.getUserPlayStat(authInfo.username);

    const registrationDays = calculateRegistrationDays(userCreatedAt);
    const firstLoginTime = userStats.firstLoginTime || userStats.lastLoginTime || userStats.lastLoginDate || 0;
    const loginDays = firstLoginTime > 0
      ? calculateRegistrationDays(firstLoginTime)
      : 0;

    const enhancedStats = {
      ...userStats,
      totalMovies: userStats.totalMovies ?? userStats.totalPlays ?? 0,
      firstWatchDate: userStats.firstWatchDate ?? userStats.lastPlayTime ?? Date.now(),
      lastUpdateTime: userStats.lastUpdateTime ?? Date.now(),
      registrationDays,
      loginDays,
      loginCount: userStats.loginCount ?? 0,
      firstLoginTime: userStats.firstLoginTime ?? 0,
      lastLoginTime: userStats.lastLoginTime ?? userStats.lastLoginDate ?? 0,
      lastLoginDate: userStats.lastLoginDate ?? userStats.lastLoginTime ?? 0
    };

    return NextResponse.json(enhancedStats, { status: 200 });
  } catch (err) {
    console.error('获取用户个人统计失败:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    console.log('POST /api/user/my-stats - 开始处理请求');

    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!db.isStatsSupported()) {
      return NextResponse.json(
        {
          error: '当前存储类型不支持播放统计功能，请使用 Redis、Upstash 或 Kvrocks',
          supportedTypes: ['redis', 'upstash', 'kvrocks']
        },
        { status: 400 }
      );
    }

    const envUsername = process.env.USERNAME;
    if (authInfo.username !== envUsername) {
      const userInfo = await db.getUserInfoV2(authInfo.username);
      if (!userInfo) {
        return NextResponse.json({ error: '用户不存在' }, { status: 401 });
      }
      if (userInfo.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    const body = await request.json();
    const { watchTime, movieKey, timestamp, isRecalculation } = body;

    if (typeof watchTime !== 'number' || !movieKey || !timestamp) {
      return NextResponse.json(
        { error: '参数错误：需要 watchTime, movieKey, timestamp' },
        { status: 400 }
      );
    }

    const currentStats = await db.getUserPlayStat(authInfo.username);

    const updatedStats = {
      ...currentStats,
      totalWatchTime: isRecalculation
        ? watchTime
        : currentStats.totalWatchTime + watchTime,
      lastUpdateTime: timestamp,
      firstWatchDate: currentStats.firstWatchDate || timestamp,
      totalMovies: currentStats.totalMovies || currentStats.totalPlays || 1
    };

    console.log('更新用户统计数据:', updatedStats);

    return NextResponse.json({
      success: true,
      userStats: updatedStats
    });
  } catch (error) {
    console.error('POST /api/user/my-stats - 详细错误信息:', error);
    return NextResponse.json(
      {
        error: '更新用户统计数据失败',
        details: process.env.NODE_ENV === 'development' ? (error as Error)?.message : undefined
      },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    console.log('PUT /api/user/my-stats - 记录用户登入时间');

    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!db.isStatsSupported()) {
      return NextResponse.json(
        {
          error: '当前存储类型不支持播放统计功能，请使用 Redis、Upstash 或 Kvrocks',
          supportedTypes: ['redis', 'upstash', 'kvrocks']
        },
        { status: 400 }
      );
    }

    const envUsername = process.env.USERNAME;
    if (authInfo.username !== envUsername) {
      const userInfo = await db.getUserInfoV2(authInfo.username);
      if (!userInfo) {
        return NextResponse.json({ error: '用户不存在' }, { status: 401 });
      }
      if (userInfo.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    const body = await request.json();
    const { loginTime } = body;

    if (!loginTime || typeof loginTime !== 'number') {
      return NextResponse.json(
        { error: '参数错误：需要 loginTime' },
        { status: 400 }
      );
    }

    const currentStats = await db.getUserPlayStat(authInfo.username);

    const updatedStats = {
      ...currentStats,
      lastLoginTime: loginTime,
      lastLoginDate: loginTime,
      firstLoginTime: currentStats.firstLoginTime || currentStats.lastLoginDate || loginTime,
      loginCount: (currentStats.loginCount || 0) + 1,
      lastUpdateTime: loginTime
    };

    try {
      await db.updateUserLoginStats(authInfo.username, loginTime, updatedStats.loginCount === 1);
      console.log('用户登入统计已保存到数据库:', {
        username: authInfo.username,
        loginTime,
        isFirstLogin: updatedStats.loginCount === 1
      });
    } catch (saveError) {
      console.error('保存登入统计失败:', saveError);
    }

    return NextResponse.json({
      success: true,
      message: '登入时间记录成功',
      loginTime,
      loginCount: updatedStats.loginCount
    });
  } catch (error) {
    console.error('PUT /api/user/my-stats - 记录登入时间失败:', error);
    return NextResponse.json(
      {
        error: '记录登入时间失败',
        details: process.env.NODE_ENV === 'development' ? (error as Error)?.message : undefined
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!db.isStatsSupported()) {
      return NextResponse.json(
        {
          error: '当前存储类型不支持播放统计功能，请使用 Redis、Upstash 或 Kvrocks',
          supportedTypes: ['redis', 'upstash', 'kvrocks']
        },
        { status: 400 }
      );
    }

    const envUsername = process.env.USERNAME;
    if (authInfo.username !== envUsername) {
      const userInfo = await db.getUserInfoV2(authInfo.username);
      if (!userInfo) {
        return NextResponse.json({ error: '用户不存在' }, { status: 401 });
      }
      if (userInfo.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    console.log('清除用户统计数据:', authInfo.username);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('清除用户统计数据失败:', error);
    return NextResponse.json(
      { error: '清除用户统计数据失败' },
      { status: 500 }
    );
  }
}
