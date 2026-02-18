const { getLicense } = require("../utils/licenseStore");

module.exports = function licenseGuard(req, res, next) {
  const license = getLicense();

  const allowedPaths = [
    "/lock.html",
    "/api/system",
    "/public",
    "/reports"
  ];

  // Allow static assets
  if (allowedPaths.some(p => req.path.startsWith(p))) {
    return next();
  }

  if (license.status === "LOCKED") {
    return res.redirect("/lock.html");
  }

  if (license.status === "GRACE") {
    const lockedAt = new Date(license.lockedAt);
    const now = new Date();
    const diffHrs = (now - lockedAt) / 36e5;

    if (diffHrs > license.graceHours) {
      return res.redirect("/lock.html");
    }
  }

  next();
};
