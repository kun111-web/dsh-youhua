import React from 'react';
import { BarChart3 } from 'lucide-react';
import { App } from './App.jsx';
import css from './style.css';
export const inject=['slots'];
export function apply(ctx){
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='dsh-usage-stats-local';style.textContent=css;document.head.append(style);return()=>style.remove();});
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'usage-stats-local',order:25,label:()=> '使用统计'},App));
  ctx.slots.inject('settings.section.icon',()=>ctx.slots.register({name:'settings.section.icon',id:'usage-stats-local'},({size=16})=><BarChart3 size={size}/>));
}
