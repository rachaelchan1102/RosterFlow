# RosterFlow

**Scheduling for Music for the Golden Age**, a volunteer group of 60+ musicians who play live shows
at 7 long-term care homes across the GTA.

Each month someone has to decide who plays which show, how many songs each person plays, who can
carpool, and who's on standby when someone cancels. RosterFlow takes
the upcoming shows, everyone's availability and limits, and the organization's rules, and builds a
schedule the coordinator can review, tweak and publish.

**Live demo:** https://rosterflow-phi.vercel.app. It opens on made-up sample data you can click
around in freely; your changes reset when you refresh.

> **⚠️ All data in the demo is fake. Please don't contact anyone listed in it.** Some real
> care home names and addresses are used for the map, but they aren't affiliated with Music for the
> Golden Age.

## What it does

- **Builds the schedule** for every show, fairly and with as little driving as possible.
- **Plans for cancellations** with three ranked backups per show.
- **Groups carpools** for musicians who live near each other.
- **Drafts before publishing**, so nothing changes until you're ready, and you can lock or block people from shows.
- **Planning tools** to test new show dates, extra cancellations and growing demand.
- **Activity log** of every change and who made it, with undo.
- **Self-service links** so musicians can mark which shows they can make.

## How the scheduling works

The scheduler is a constraint programming model built with Google OR-Tools. Every schedule has to
follow the group's rules:

- Only people who said they're free get booked, and nobody plays two shows in one day.
- Nobody goes over their monthly limit.
- Every show has at least 3 musicians, including a pianist, and everyone gets to play at least one song.
- Musicians under 17 only get shows close enough for a guardian to drive them.

Within those rules, it aims for the best schedule it can find, in this order of importance:

1. Every show has enough music to fill its time.
2. Everyone gets a fair share of chances to play.
3. Less driving, with carpooling counted, so sharing a car helps.
4. Musicians get to play at different homes instead of the same one every time.

## Tech

- **Backend:** Python, FastAPI, pandas, OR-Tools
- **Frontend:** React, TypeScript, Vite, Leaflet, Recharts
- **Database:** Postgres (Neon)
- **Hosting:** Vercel
