import { Request, Response } from 'express';
import { getAllChargers, getChargerById } from '../services/ocpp/steve-adapter';
import winston from '../config/logger';

export const listChargers = async (req: Request, res: Response): Promise<void> => {
  try {
    const chargers = await getAllChargers();
    res.json({ success: true, data: chargers });
  } catch (error) {
    winston.error('Failed to list chargers', { error });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getCharger = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const charger = await getChargerById(id);
    
    if (!charger) {
      res.status(404).json({ success: false, error: 'Charger not found' });
      return;
    }
    
    res.json({ success: true, data: charger });
  } catch (error) {
    winston.error(`Failed to fetch charger ${req.params.id}`, { error });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
