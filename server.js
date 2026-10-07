const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { get } = require('./src/db');
const { loadUser, csrf, homeFor } = require('./src/auth');
const { viewLocals } = require('./src/helpers');
const { unreadCount } = require('./src/notify');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '200kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });
  app.use(viewLocals);
  app.use(loadUser);
  app.use(csrf);
  app.use((req, res, next) => {
    res.locals.unread = req.user ? unreadCount(req.user.id) : 0;
    res.locals.navCounts =
      req.user && req.user.role === 'admin'
        ? {
            queue: get("SELECT COUNT(*) AS n FROM service_requests WHERE status = 'submitted'").n,
            leads: get("SELECT COUNT(*) AS n FROM leads WHERE status = 'new'").n,
            contractors: get("SELECT COUNT(*) AS n FROM contractor_profiles WHERE status = 'submitted'").n,
          }
        : null;
    res.locals.dashboardPath = req.user ? homeFor(req.user) : '/';
    next();
  });

  app.use('/', require('./src/routes/public'));
  app.use('/', require('./src/routes/auth'));
  app.use('/notifications', require('./src/routes/notifications'));
  app.use('/portal', require('./src/routes/portal'));
  app.use('/admin', require('./src/routes/admin'));
  app.use('/crew', require('./src/routes/crew'));
  app.use('/', require('./src/routes/work'));

  app.use((req, res) => {
    res.status(404).render('shared/error', { title: 'Page not found', message: "We couldn't find that page. Check the address or head back home." });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('shared/error', { title: 'Something went wrong', message: 'An unexpected error occurred. Our team has been notified.' });
  });

  return app;
}

if (require.main === module) {
  const hasUsers = get('SELECT COUNT(*) AS n FROM users').n > 0;
  if (!hasUsers) require('./src/seed').seed();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Valor Valet running at http://localhost:${port}`));
}

module.exports = { createApp };
