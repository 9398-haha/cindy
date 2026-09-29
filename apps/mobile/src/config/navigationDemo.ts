import * as Application from 'expo-application';
import Constants from 'expo-constants';

/** Both the JS opt-in and the installed native identity must belong to the trial. */
export const IS_NAVIGATION_DEMO = process.env.EXPO_PUBLIC_CINDY_NAV_DEMO === '1'
  && Constants.expoConfig?.extra?.navigationDemo === true
  && ['com.xd.cindy.navdemo', 'com.xd.cindycn.navdemo'].includes(Application.applicationId ?? '');

export const NAVIGATION_DEMO_SCHEME = IS_NAVIGATION_DEMO && Application.applicationId === 'com.xd.cindycn.navdemo'
  ? 'cindycnnavdemo' : 'cindynavdemo';
