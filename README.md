# gta6-twitch-ccu-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Nr1414-dev/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Nr1414-dev/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts how many people watch Grand Theft Auto VI live on Twitch in each hour of its release day (2026-11-19 UTC), as five quantiles per hour, from everything recorded up to the end of the first hour. It is an empirical analogue model, not a guess at a big number: it takes the case's comparables — past big game launches' hourly Twitch curves — keeps only the launches that unlocked at midnight local time, rolling around the world, like GTA VI does, and for each hour regresses the log-ratio to hour 1 on the launch's hour-1 size (big hour-1 launches barely grow afterwards; small ones grow several-fold by the evening), with the spread taken from the pooled standardised residuals so the 5%/95% band is honestly wide and skewed upward. On the four practice launches it scores a mean pinball loss of 0.176 against the house persistence baseline's 0.387, with a typical miss of ~29% and 90% coverage of 0.95. See the header comment of `main.ts` for the full method and validation.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=mzt460aw&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards
