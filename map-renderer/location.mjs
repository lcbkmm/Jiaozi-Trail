// The caller supplies geolocation and coordinate conversion; this module has no
// browser globals, SDK dependency, network requests, or implicit location watch.
export function createLocationTracker({ geolocation, convert, onPosition = () => {}, onError = () => {}, onState = () => {} }) {
  if (typeof convert !== 'function') throw new TypeError('convert must be a function');
  for (const [name, callback] of Object.entries({ onPosition, onError, onState })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }

  let active = false;
  let watchId = null;
  let session = 0;
  let nextFix = 0;
  let lastApplied = 0;

  const current = token => active && token === session;
  const coordinate = value => {
    if (!Array.isArray(value) || value.length !== 2 ||
        !value.every(number => typeof number === 'number' && Number.isFinite(number)) ||
        value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
      throw new TypeError('Location requires a valid [longitude, latitude] coordinate');
    }
    return [...value];
  };

  const clear = id => {
    try { geolocation.clearWatch(id); }
    catch (error) { onError(error); }
  };

  function stop() {
    if (!active) return false;
    const id = watchId;
    // Invalidate pending results before calling any external observer or API.
    active = false;
    watchId = null;
    session++;
    if (id !== null) clear(id);
    onState(false);
    return true;
  }

  function receivePosition(fix, token) {
    if (!current(token)) return;
    let accuracy, conversion;
    const sequence = ++nextFix;
    try {
      const input = coordinate([fix?.coords?.longitude, fix?.coords?.latitude]);
      accuracy = fix.coords.accuracy;
      if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0) {
        throw new TypeError('Location accuracy must be a finite nonnegative number');
      }
      // Calling within this try also catches synchronous SDK conversion errors.
      conversion = convert(input);
    } catch (error) {
      if (current(token)) onError(error);
      return;
    }

    Promise.resolve(conversion).then(result => {
      if (!current(token) || sequence <= lastApplied) return;
      const converted = coordinate(result?.coordinate);
      if (result.method !== 'baidu' && result.method !== 'local') {
        throw new TypeError('Conversion method must be baidu or local');
      }
      // A newer *pending* fix does not invalidate this completed fix. Only a
      // newer already-applied result may suppress it, so slow conversion cannot
      // starve location updates when GPS fixes arrive frequently.
      lastApplied = sequence;
      onPosition({ coordinate: converted, accuracy, method: result.method });
    }).catch(error => {
      if (current(token) && sequence > lastApplied) onError(error);
    });
  }

  function receiveError(error, token) {
    if (!current(token)) return;
    if (error?.code === 1) stop();
    onError(error);
  }

  function start() {
    if (active) return true;
    if (!geolocation || typeof geolocation.watchPosition !== 'function' || typeof geolocation.clearWatch !== 'function') {
      onError(new Error('Device geolocation is not available'));
      return false;
    }
    const token = ++session;
    nextFix = 0;
    lastApplied = 0;
    active = true;
    onState(true);
    // An onState observer may synchronously stop/restart the tracker.
    if (!current(token)) return false;
    try {
      const id = geolocation.watchPosition(
        fix => receivePosition(fix, token),
        error => receiveError(error, token),
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
      );
      // Some adapters invoke their error callback before returning the watch ID.
      // If it stopped this session, clear its returned ID without disturbing a
      // new watch that an observer might already have started.
      if (!current(token)) {
        if (id !== null && id !== undefined) clear(id);
        return false;
      }
      if (!Number.isInteger(id) || id < 0) throw new TypeError('Geolocation returned an invalid watch ID');
      watchId = id;
      return true;
    } catch (error) {
      if (current(token)) {
        stop();
        onError(error);
      }
      return false;
    }
  }

  return { start, stop, isActive: () => active };
}
