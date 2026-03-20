// components/ChargingSession.tsx
import { useChargingSession } from '../hooks/useChargingSession';

function ChargingSession() {
  const { session, isConnected, subscribeToCharger } = useChargingSession(
    userId,
    idTag,
    jwtToken
  );

  useEffect(() => {
    // Subscribe to charger updates after session starts
    if (session.chargeBoxId) {
      subscribeToCharger(session.chargeBoxId);
    }
  }, [session.chargeBoxId]);

  return (
    <div>
      <div>Connection: {isConnected ? '🟢 Real-time' : '🟡 Polling'}</div>
      
      {session.status === 'pending' && (
        <div>⏳ Starting charging session...</div>
      )}
      
      {session.status === 'active' && (
        <div>
          ⚡ Charging in progress
          <div>Transaction: {session.transactionId}</div>
          <div>Charger: {session.chargeBoxId}:{session.connectorId}</div>
          <button>Stop Charging</button>
        </div>
      )}
      
      {session.status === 'completed' && (
        <div>
          ✅ Session completed
          <div>Energy: {session.energyKwh} kWh</div>
          <div>Cost: ${session.totalCost}</div>
        </div>
      )}
    </div>
  );
}
